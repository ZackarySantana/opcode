import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { isBuiltin } from "node:module"
import ts from "typescript"
import { buildPlugin } from "../scripts/build"
import { declarationFile, dependencyFields, inside, manifestAt, packageName, pluginIDs, publicPackageName, repositoryRoot, resolveCatalog, type Manifest } from "../scripts/packaging"
import { assertReleaseCoverage, checkReleasePolicy, parseChangeset, requiredConsumers } from "../scripts/release-policy"

const temporary: string[] = []
async function temp(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(directory)
  return directory
}
afterAll(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true })
})

async function command(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status) throw new Error(`${args.join(" ")}: ${stderr}\n${stdout}`)
  return stdout
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
}

async function packAndInspect(stage: string) {
  const isolated = await temp("opcode-packed-")
  const packed = JSON.parse(await command(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", isolated], stage)) as { filename: string }[]
  await command(["tar", "-xzf", join(isolated, packed[0]!.filename), "-C", isolated], isolated)
  const directory = join(isolated, "package")
  const manifest = await manifestAt(directory)
  expect(manifest.private).not.toBe(true)
  expect(manifest.devDependencies).toBeUndefined()
  expect(manifest.scripts).toBeUndefined()
  expect(await readFile(join(directory, "LICENSE"), "utf8")).toBe(await readFile(join(repositoryRoot, "LICENSE"), "utf8"))
  expect(existsSync(join(directory, "README.md"))).toBe(true)
  for (const field of dependencyFields) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      expect(name.startsWith("@opcode/")).toBe(false)
      expect(version).not.toMatch(/^(workspace|catalog|file|link):/)
    }
  }
  for (const host of ["@opentui/core", "@opentui/solid", "solid-js"]) {
    if (manifest.peerDependencies?.[host]) expect(manifest.dependencies?.[host]).toBeUndefined()
  }
  const installed = join(isolated, "node_modules", manifest.name)
  await mkdir(dirname(installed), { recursive: true })
  await symlink(directory, installed)
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    const entry = value as { types: string; import: string; default: string }
    expect(entry.types).toEndWith(".d.ts")
    for (const target of Object.values(entry)) {
      const path = resolve(directory, target)
      expect(inside(directory, path)).toBe(true)
      expect(existsSync(path)).toBe(true)
    }
    const specifier = key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`
    expect(Bun.resolveSync(specifier, isolated)).toBe(resolve(directory, entry.import))
    const resolvedType = ts.resolveModuleName(specifier, join(isolated, "consumer.ts"), {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
    }, ts.sys).resolvedModule
    expect(resolvedType?.resolvedFileName).toBe(resolve(directory, entry.types))
  }
  const allFiles = await files(directory)
  let sourceCount = 0
  const externals = new Set<string>()
  for (const file of allFiles) {
    expect(file).not.toContain("/node_modules/")
    if (file.endsWith(".map")) {
      const map = JSON.parse(await readFile(file, "utf8")) as { sources: string[] }
      sourceCount += map.sources.length
      for (const source of map.sources) {
        expect(source).not.toContain("node_modules")
        expect(source).not.toMatch(/(?:@opencode|@opentui|solid-js)[/\\]/)
      }
    }
    if (file.endsWith(".js") || file.endsWith(".d.ts")) {
      const source = await readFile(file, "utf8")
      const imports = ts.preProcessFile(source, true, true).importedFiles.map((item) => item.fileName)
      for (const specifier of imports) {
        expect(specifier.startsWith("@opcode/")).toBe(false)
        if (specifier.startsWith(".")) {
          const path = resolve(dirname(file), specifier)
          expect(inside(directory, path)).toBe(true)
          expect(file.endsWith(".d.ts") ? declarationFile(path) !== undefined : existsSync(path)).toBe(true)
        } else if (!isBuiltin(specifier) && specifier !== "bun" && !specifier.startsWith("bun:")) {
          const name = packageName(specifier)
          externals.add(name)
          if (!dependencyFields.some((field) => manifest[field]?.[name] !== undefined)) {
            throw new Error(`${manifest.name}: undeclared external ${specifier} in ${file.slice(directory.length + 1)}`)
          }
        }
      }
    }
  }
  expect(sourceCount).toBeGreaterThan(0)
  expect(externals.has("@opencode/plugin")).toBe(true)
  return { directory, manifest, externals }
}

async function fixture() {
  const root = await temp("opcode-build-")
  await symlink(join(repositoryRoot, "node_modules"), join(root, "node_modules"))
  await cp(join(repositoryRoot, "LICENSE"), join(root, "LICENSE"))
  await cp(join(repositoryRoot, "tsconfig.json"), join(root, "tsconfig.json"))
  await cp(join(repositoryRoot, "package.json"), join(root, "package.json"))
  async function put(path: string, contents: string | object) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), typeof contents === "string" ? contents : JSON.stringify(contents))
  }
  await put("packages/core/package.json", { name: "@opcode/core", version: "0.0.0", private: true, type: "module", exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }, dependencies: { "@opencode/client": "catalog:" } })
  await put("packages/core/src/index.ts", 'export type Result = { value: string }; export const decorate = (value: string): Result => ({ value: `bundled:${value}` })')
  await put("packages/core/src/rpc.ts", 'export type RpcResult = { ready: boolean }')
  await put("packages/ui/package.json", { name: "@opcode/ui", version: "0.0.0", private: true, type: "module", exports: { ".": "./src/index.tsx" }, dependencies: { "@opcode/core": "workspace:*", "@opentui/solid": "catalog:", "solid-js": "catalog:" } })
  await put("packages/ui/src/index.tsx", 'import { decorate } from "@opcode/core"; import { createMemo } from "solid-js"; export const Label = () => { const label = createMemo(() => decorate("hello").value); return <text>{label()}</text> }')
  await put("plugins/context/package.json", { name: publicPackageName("context"), version: "1.2.3", description: "Packaging regression fixture", type: "module", dependencies: { "@opcode/core": "workspace:*", "@opcode/ui": "workspace:*", "@opencode/plugin": "catalog:" }, peerDependencies: { "@opentui/solid": "catalog:host", "solid-js": "catalog:host" } })
  await put("plugins/context/src/index.ts", 'import { Plugin } from "@opencode/plugin"; import { decorate } from "@opcode/core"; export { decorate }; export default Plugin.define({ id: "opcode-context", setup() {} })')
  await put("plugins/context/src/tui.tsx", 'import { Plugin } from "@opencode/plugin/tui"; import { Label } from "@opcode/ui"; export default Plugin.define({ id: "opcode-context.tui", setup(ctx) { ctx.ui.slot({ append: "home.footer", render: () => <Label /> }) } })')
  await put("plugins/context/src/rpc.ts", 'export type { RpcResult } from "@opcode/core/rpc"; export { decorate } from "@opcode/core"')
  return root
}

describe("npm artifacts", () => {
  test("private source and JSX are bundled, host runtimes stay external, and private declarations resolve in the tarball", async () => {
    const root = await fixture()
    const stage = await buildPlugin(root, "context")
    const { directory, externals, manifest } = await packAndInspect(stage)
    expect(Object.keys(manifest.exports!).sort()).toEqual([".", "./rpc", "./tui"])
    expect(externals.has("solid-js")).toBe(true)
    expect(externals.has("@opentui/solid")).toBe(true)
    expect(manifest.peerDependencies?.["solid-js"]).toBeDefined()
    const workspace = await manifestAt(join(root, "plugins/context"))
    expect(workspace.dependencies?.["@opencode/client"]).toBeUndefined()
    expect(manifest.dependencies?.["@opencode/client"]).toBe(resolveCatalog("catalog:", "@opencode/client", await manifestAt(root)))
    const consumerRoot = dirname(directory)
    expect(JSON.parse(await command([process.execPath, "-e", 'import { decorate } from "@lidtop/opencode-context/rpc"; console.log(JSON.stringify(decorate("packed")))'], consumerRoot))).toEqual({ value: "bundled:packed" })
    const consumer = join(consumerRoot, "consumer.ts")
    await writeFile(consumer, `import { decorate, type RpcResult } from "@lidtop/opencode-context/rpc"
const value: string = decorate("typed").value
const result: RpcResult = { ready: true }
// @ts-expect-error The packed declaration must retain the string result, not any.
const invalidValue: number = decorate("typed").value
// @ts-expect-error Private re-exported RPC declarations must retain boolean fields.
const invalidResult: RpcResult = { ready: "wrong" }
void [value, result, invalidValue, invalidResult]
`)
    const program = ts.createProgram([consumer], {
      noEmit: true,
      strict: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    })
    expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
    // Staging must not rewrite workspace source manifests.
    expect((await manifestAt(join(root, "plugins/context"))).dependencies?.["@opcode/core"]).toBe("workspace:*")
    await rm(join(root, "plugins/context/src/rpc.ts"))
    const rebuilt = await buildPlugin(root, "context")
    expect((await manifestAt(rebuilt)).exports?.["./rpc"]).toBeUndefined()
    expect(existsSync(join(rebuilt, "dist/rpc.js"))).toBe(false)
  }, 120_000)

  test("all four real packages pack with resolvable exports and self-contained private code/types", async () => {
    for (const id of pluginIDs) {
      const { manifest } = await packAndInspect(await buildPlugin(repositoryRoot, id))
      expect(manifest.name).toBe(`@lidtop/opencode-${id}`)
      expect(manifest.version).toBe((await manifestAt(join(repositoryRoot, "plugins", id))).version)
    }
  }, 180_000)
})

describe("independent release policy", () => {
  const manifests = new Map<string, Manifest>([
    ["@opcode/core", { name: "@opcode/core", version: "0.0.0", private: true }],
    ["@opcode/ui", { name: "@opcode/ui", version: "0.0.0", private: true, dependencies: { "@opcode/core": "workspace:*" } }],
    ["@lidtop/opencode-context", { name: "@lidtop/opencode-context", version: "1.0.0", dependencies: { "@opcode/ui": "workspace:*" } }],
    ["@lidtop/opencode-cost", { name: "@lidtop/opencode-cost", version: "2.0.0", dependencies: { "@opcode/core": "workspace:*" } }],
    ["@lidtop/opencode-sessions", { name: "@lidtop/opencode-sessions", version: "8.0.0" }],
  ])
  test("shared changes require explicit transitive public consumers, not synchronized unrelated versions", () => {
    const required = requiredConsumers(new Set(["@opcode/core"]), manifests)
    expect([...required].sort()).toEqual(["@lidtop/opencode-context", "@lidtop/opencode-cost"])
    expect(() => assertReleaseCoverage(required, [{ name: "@lidtop/opencode-context", type: "patch" }])).toThrow("@lidtop/opencode-cost")
    expect(() => assertReleaseCoverage(required, parseChangeset('---\n"@lidtop/opencode-context": patch\n"@lidtop/opencode-cost": minor\n---\nFix shared behavior.'))).not.toThrow()
    expect([...requiredConsumers(new Set(["@opcode/ui"]), manifests)]).toEqual(["@lidtop/opencode-context"])
  })
  test("default/named catalogs materialize and invalid release specs fail closed", () => {
    const root: Manifest = { name: "root", version: "0.0.0", workspaces: { catalog: { host: "2.1.1" }, catalogs: { peers: { host: "^2.1.1" } } } }
    expect(resolveCatalog("catalog:", "host", root)).toBe("2.1.1")
    expect(resolveCatalog("catalog:peers", "host", root)).toBe("^2.1.1")
    expect(() => resolveCatalog("catalog:", "missing", root)).toThrow("concrete catalog")
    expect(() => parseChangeset("---\npackage: invalid\n---\nDescription")).toThrow("release type")
    expect(parseChangeset("---\n---\nNo public release.")).toEqual([])
  })

  test("Changesets versions only the selected plugin and never versions bundled private workspaces", async () => {
    const root = await fixture()
    await mkdir(join(root, ".changeset"))
    await cp(join(repositoryRoot, ".changeset/config.json"), join(root, ".changeset/config.json"))
    await writeFile(join(root, ".changeset/fix.md"), '---\n"@lidtop/opencode-context": patch\n---\nFix fixture behavior.\n')
    await mkdir(join(root, "plugins/sessions"), { recursive: true })
    await writeFile(join(root, "plugins/sessions/package.json"), JSON.stringify({ name: publicPackageName("sessions"), version: "7.4.0", dependencies: { "@opcode/core": "workspace:*" } }))
    await command([process.execPath, join(repositoryRoot, "node_modules/@changesets/cli/bin.js"), "version"], root)
    expect((await manifestAt(join(root, "plugins/context"))).version).toBe("1.2.4")
    expect((await manifestAt(join(root, "plugins/sessions"))).version).toBe("7.4.0")
    expect((await manifestAt(join(root, "packages/core"))).version).toBe("0.0.0")
    expect((await manifestAt(join(root, "packages/ui"))).version).toBe("0.0.0")
    expect(existsSync(join(root, "plugins/context/CHANGELOG.md"))).toBe(true)
    expect(existsSync(join(root, ".changeset/fix.md"))).toBe(false)
  }, 30_000)

  test("PR policy covers private source and shared host upgrades but allows consumed version-only release PRs", async () => {
    const root = await fixture()
    for (const id of pluginIDs) {
      const directory = join(root, "plugins", id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "package.json"), JSON.stringify({ name: publicPackageName(id), version: "1.0.0", dependencies: { "@opcode/core": "workspace:*", "@opcode/ui": "workspace:*", "@opencode/plugin": "catalog:" } }))
    }
    await mkdir(join(root, ".changeset"))
    const git = (...args: string[]) => command(["git", ...args], root)
    async function commit() {
      await git("add", ".")
      await git("-c", "user.name=Packaging Test", "-c", "user.email=packaging@example.invalid", "commit", "-m", "fixture")
    }
    await git("init", "-b", "main")
    await commit()
    await git("branch", "baseline")
    await writeFile(join(root, "packages/core/src/index.ts"), 'export const updated = true\n')
    await commit()
    await expect(checkReleasePolicy(root, "baseline")).rejects.toThrow("@lidtop/opencode-context, @lidtop/opencode-cost, @lidtop/opencode-later, @lidtop/opencode-sessions")
    await writeFile(join(root, ".changeset/fix.md"), `---\n${pluginIDs.map((id) => `"${publicPackageName(id)}": patch`).join("\n")}\n---\nUpdate shared behavior.\n`)
    await commit()
    await expect(checkReleasePolicy(root, "baseline")).resolves.toBeUndefined()
    await git("branch", "before-version")
    await rm(join(root, ".changeset/fix.md"))
    const plugin = await manifestAt(join(root, "plugins/context"))
    plugin.version = "1.0.1"
    await writeFile(join(root, "plugins/context/package.json"), JSON.stringify(plugin))
    await commit()
    await expect(checkReleasePolicy(root, "before-version")).resolves.toBeUndefined()
    await git("branch", "before-host-upgrade")
    const manifest = await manifestAt(root)
    for (const name of Object.keys(manifest.workspaces!.catalog!)) {
      if (name.startsWith("@opencode/")) manifest.workspaces!.catalog![name] = "2.2.0"
    }
    await writeFile(join(root, "package.json"), JSON.stringify(manifest))
    await commit()
    await expect(checkReleasePolicy(root, "before-host-upgrade")).rejects.toThrow("@lidtop/opencode-context, @lidtop/opencode-cost, @lidtop/opencode-later, @lidtop/opencode-sessions")
  }, 30_000)

  test("catalog policy precisely covers named peers and inherited SDK/optional dependencies, not dev-only entries", async () => {
    const root = await fixture()
    const rootManifest = await manifestAt(root)
    rootManifest.workspaces!.catalogs!.sdk = { "@opencode/client": "2.1.1", "@opencode/theme": "2.1.1" }
    await writeFile(join(root, "package.json"), JSON.stringify(rootManifest))
    const core = await manifestAt(join(root, "packages/core"))
    core.dependencies!["@opencode/client"] = "catalog:sdk"
    await writeFile(join(root, "packages/core/package.json"), JSON.stringify(core))
    const ui = await manifestAt(join(root, "packages/ui"))
    ui.optionalDependencies = { "@opencode/theme": "catalog:sdk" }
    await writeFile(join(root, "packages/ui/package.json"), JSON.stringify(ui))
    const plugins = [
      { id: "context", dependencies: { "@opcode/ui": "workspace:*" }, peerDependencies: { "solid-js": "catalog:host" } },
      { id: "cost", dependencies: { "@opcode/core": "workspace:*" } },
      { id: "later", dependencies: { "@opencode/plugin": "catalog:" } },
      { id: "sessions" },
    ] as const
    for (const plugin of plugins) {
      const { id, ...manifest } = plugin
      const directory = join(root, "plugins", id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "package.json"), JSON.stringify({ name: publicPackageName(id), version: "1.0.0", ...manifest }))
    }
    await mkdir(join(root, ".changeset"))
    const git = (...args: string[]) => command(["git", ...args], root)
    async function commit() {
      await git("add", ".")
      await git("-c", "user.name=Packaging Test", "-c", "user.email=packaging@example.invalid", "commit", "-m", "fixture")
    }
    await git("init", "-b", "main")
    await commit()
    await git("branch", "baseline")
    async function checkCatalogChange(change: (manifest: Manifest) => void, required: string[]) {
      const next = structuredClone(rootManifest)
      change(next)
      await writeFile(join(root, "package.json"), JSON.stringify(next))
      await commit()
      if (required.length) {
        await expect(checkReleasePolicy(root, "baseline")).rejects.toThrow(new RegExp(`^Add explicit consumer changesets for: ${required.join(", ")}$`))
        await writeFile(join(root, ".changeset/catalog.md"), `---\n${required.map((name) => `"${name}": patch`).join("\n")}\n---\nUpdate runtime contract.\n`)
        await expect(checkReleasePolicy(root, "baseline")).resolves.toBeUndefined()
        await rm(join(root, ".changeset/catalog.md"))
      } else await expect(checkReleasePolicy(root, "baseline")).resolves.toBeUndefined()
    }
    await checkCatalogChange((manifest) => { manifest.workspaces!.catalog!.typescript = "5.9.0" }, [])
    await checkCatalogChange((manifest) => { manifest.workspaces!.catalogs!.host!["solid-js"] = ">=1.9.15 <2" }, ["@lidtop/opencode-context"])
    await checkCatalogChange((manifest) => { manifest.workspaces!.catalogs!.sdk!["@opencode/client"] = "2.2.0" }, ["@lidtop/opencode-context", "@lidtop/opencode-cost"])
    await checkCatalogChange((manifest) => { manifest.workspaces!.catalogs!.sdk!["@opencode/theme"] = "2.2.0" }, ["@lidtop/opencode-context"])
  }, 30_000)
})
