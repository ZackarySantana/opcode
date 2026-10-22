import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

export const pluginIDs = ["context", "cost", "later", "sessions"] as const
export function publicPackageName(id: typeof pluginIDs[number]) {
  return `@lidtop/opencode-${id}`
}

export const dependencyFields = ["dependencies", "peerDependencies", "optionalDependencies"] as const
export type Manifest = {
  name: string
  version: string
  private?: boolean
  exports?: Record<string, unknown>
  workspaces?: { catalog?: Record<string, string>; catalogs?: Record<string, Record<string, string>> }
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  [key: string]: unknown
}

export async function manifestAt(directory: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
}

/** A workspace plugin manifest, rejected unless it is the expected public package. */
export async function publicManifest(root: string, id: typeof pluginIDs[number]): Promise<Manifest> {
  const directory = join(root, "plugins", id)
  const manifest = await manifestAt(directory)
  if (manifest.name !== publicPackageName(id) || manifest.private) throw new Error(`Expected public package ${publicPackageName(id)} in ${directory}`)
  return manifest
}

/** Run a command and return its stdout; failures include both streams. */
export async function run(args: string[], cwd: string, options: { echo?: boolean } = {}): Promise<string> {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status) throw new Error(`${args.join(" ")} failed: ${stderr}\n${stdout}`)
  if (options.echo && stderr) console.error(stderr.trim())
  return stdout
}

/** Host-owned singleton runtimes: plugins must declare these as peers, never ship their own. */
export function hostSingletons(root: Manifest): string[] {
  return Object.keys(root.workspaces?.catalogs?.host ?? {})
}

export function packageName(specifier: string): string {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!
}

export function inside(directory: string, file: string): boolean {
  const path = relative(directory, file)
  return path !== ".." && !path.startsWith("../") && !isAbsolute(path)
}

export function resolveCatalog(specifier: string, dependency: string, root: Manifest): string {
  if (!specifier.startsWith("catalog:")) return specifier
  const catalog = specifier.slice("catalog:".length)
  const value = catalog ? root.workspaces?.catalogs?.[catalog]?.[dependency] : root.workspaces?.catalog?.[dependency]
  if (!value || /^(catalog|workspace|file|link):/.test(value)) {
    throw new Error(`Missing concrete catalog version for ${dependency} (${specifier})`)
  }
  return value
}

export async function privateWorkspaces(root: string) {
  const entries = await Promise.all(["core", "ui"].map(async (id) => {
    const directory = join(root, "packages", id)
    const manifest = await manifestAt(directory)
    if (manifest.name !== `@opcode/${id}` || !manifest.private) throw new Error(`${directory} must be private`)
    return [manifest.name, { directory, manifest }] as const
  }))
  return new Map(entries)
}

export function workspaceSource(directory: string, manifest: Manifest, specifier: string): string {
  const suffix = specifier.slice(manifest.name.length)
  const key = suffix ? `.${suffix}` : "."
  for (const [pattern, target] of Object.entries(manifest.exports ?? {})) {
    if (typeof target !== "string") continue
    const [prefix, postfix = ""] = pattern.split("*")
    const wildcard = pattern.includes("*") && key.startsWith(prefix!) && key.endsWith(postfix)
    if (pattern !== key && !wildcard) continue
    const replacement = wildcard ? key.slice(prefix!.length, postfix ? -postfix.length : undefined) : ""
    const source = resolve(directory, target.replace("*", replacement))
    if (!inside(directory, source) || !existsSync(source)) throw new Error(`Invalid private export: ${specifier}`)
    return source
  }
  throw new Error(`Unexported private import: ${specifier}`)
}

/** The effective published dependency contract, including bundled private consumers. */
export function runtimeDependencies(rootManifest: Manifest, plugin: Manifest, workspaces: Map<string, Manifest>) {
  const dependencies: Partial<Record<typeof dependencyFields[number], Record<string, string>>> = {}
  const visited = new Set<string>()
  function collect(manifest: Manifest) {
    if (visited.has(manifest.name)) return
    visited.add(manifest.name)
    for (const field of dependencyFields) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        const workspace = workspaces.get(name)
        if (workspace) {
          collect(workspace)
          continue
        }
        const version = resolveCatalog(specifier, name, rootManifest)
        if (/^(workspace|catalog|file|link):/.test(version) || name.startsWith("@opcode/")) {
          throw new Error(`Unpublishable dependency ${name}: ${version}`)
        }
        const target = dependencies[field] ??= {}
        if (target[name] && target[name] !== version) throw new Error(`Conflicting ${field} for ${name}`)
        target[name] = version
      }
    }
  }
  collect(plugin)
  // The host owns these singleton runtimes. A consumer's explicit peer range wins
  // over an implementation dependency inherited from a bundled UI workspace.
  for (const name of hostSingletons(rootManifest)) {
    if (dependencies.peerDependencies?.[name]) {
      delete dependencies.dependencies?.[name]
      delete dependencies.optionalDependencies?.[name]
    } else if (dependencies.dependencies?.[name] || dependencies.optionalDependencies?.[name]) {
      throw new Error(`${plugin.name} must declare host singleton ${name} in peerDependencies`)
    }
  }
  return dependencies
}

/** `imports` are the external packages the built bundle actually imports. */
export async function stagedManifest(root: string, plugin: Manifest, exports: Record<string, unknown>, imports: Iterable<string> = []): Promise<Manifest> {
  const rootManifest = await manifestAt(root)
  const workspaces = await privateWorkspaces(root)
  const dependencies = runtimeDependencies(rootManifest, plugin, new Map([...workspaces].map(([name, workspace]) => [name, workspace.manifest])))
  const imported = new Set(imports)
  for (const name of hostSingletons(rootManifest)) {
    if (imported.has(name) && !dependencies.peerDependencies?.[name]) throw new Error(`${plugin.name} imports host singleton ${name} without declaring it in peerDependencies`)
  }
  const metadata = ["description", "license", "author", "contributors", "repository", "homepage", "bugs", "keywords", "engines", "funding", "peerDependenciesMeta"]
  return {
    name: plugin.name,
    version: plugin.version,
    ...Object.fromEntries(metadata.filter((key) => plugin[key] !== undefined).map((key) => [key, plugin[key]])),
    type: "module",
    main: "./dist/index.js",
    types: (exports["."] as { types: string }).types,
    exports,
    files: ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
    ...dependencies,
    publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
  }
}

/** Resolve declaration imports exactly as a consumer's bundler-style TS resolver does. */
export function declarationFile(path: string): string | undefined {
  const stem = path.replace(/\.(?:[cm]?js|tsx?|jsx)$/, "")
  return [path, `${stem}.d.ts`, `${stem}.d.mts`, join(path, "index.d.ts")].find((candidate) => existsSync(candidate) && !candidate.endsWith(".js"))
}

export function relativeModule(from: string, to: string): string {
  const path = relative(dirname(from), to).replaceAll("\\", "/")
  return path.startsWith(".") ? path : `./${path}`
}

export const repositoryRoot = resolve(import.meta.dir, "..")
