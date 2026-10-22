import { afterAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import { globalConfigFiles, prepareDev, selectPlugins, suspendPublished } from "../scripts/dev"

const temporary: string[] = []
afterAll(async () => { for (const root of temporary) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opcode-dev-test-"))
  temporary.push(root)
  for (const id of ["context", "cost", "later", "sessions", "feed", "gh-pr-status"]) {
    const directory = join(root, ".release", `opcode-${id}`, "dist")
    await mkdir(directory, { recursive: true })
    for (const entry of ["index", "tui"]) {
      await Bun.write(join(directory, `${entry}.js`), `export default { id: 'opcode-${id}', entry: '${entry}', setup() {} }`)
    }
  }
  return root
}

test("preview defaults to the suite and accepts individual package names", () => {
  expect(selectPlugins([])).toEqual(["context", "cost", "later", "sessions", "feed", "gh-pr-status"])
  expect(selectPlugins(["@lidtop/opencode-feed"])).toEqual(["feed"])
  expect(selectPlugins(["opcode-cost", "later", "cost", "@lidtop/opencode-cost", "@lidtop/opencode-sessions"])).toEqual(["cost", "later", "sessions"])
  expect(() => selectPlugins(["../../outside"])).toThrow("Unknown plugin")
})

test("preview loads both built entrypoints and separates plugin data without rewriting user config", async () => {
  const root = await fixture()
  const userConfig = join(root, "opencode.jsonc")
  await Bun.write(userConfig, "// existing project config\n{\"model\":\"example/model\"}")
  const environment = {
    OPENCODE_DB: "/normal/opencode.sqlite",
    OPENCODE_CONFIG: "/normal/config.jsonc",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "example/model", plugins: ["another-plugin"] }),
    OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ theme: { mode: "dark" } }),
  }
  const preview = await prepareDev(root, selectPlugins([]), environment)
  const settings = JSON.parse(preview.environment.OPENCODE_CONFIG_CONTENT)
  const cli = JSON.parse(preview.environment.OPENCODE_CLI_CONFIG_CONTENT)
  expect(settings.model).toBe("example/model")
  expect(settings.plugins[0]).toBe("another-plugin")
  expect(settings.plugins).toContain("-opencode-later")
  expect(settings.plugins).toContain("-opcode-later")
  expect(cli.theme).toEqual({ mode: "dark" })
  expect(cli.plugins).toContain("-opencode-later")
  expect(preview.environment.OPENCODE_DB).toBe("/normal/opencode.sqlite")
  expect(preview.environment.OPENCODE_CONFIG).toBe("/normal/config.jsonc")
  expect(await Bun.file(userConfig).text()).toBe("// existing project config\n{\"model\":\"example/model\"}")
  expect(environment.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify({ model: "example/model", plugins: ["another-plugin"] }))
  const entries = [...settings.plugins, ...cli.plugins].filter((entry: unknown): entry is { package: string; options: { database: string } } => !!entry && typeof entry === "object" && "package" in entry)
  expect(entries).toHaveLength(6)
  for (const entry of entries) {
    const id = basename(entry.options.database, ".sqlite")
    expect(entry.options.database).toBe(join(preview.data, `${id}.sqlite`))
    for (const name of ["index", "tui"]) {
      const module = await import(pathToFileURL(join(entry.package, `${name}.js`)).href)
      expect(module.default.id).toBe(`opcode-${id}`)
      expect(module.default.entry).toBe(name)
    }
  }
  expect(settings.plugins.filter((entry: unknown) => typeof entry === "object")).toHaveLength(3)
  // Client-local plugins load in the terminal process, not the server.
  expect(cli.plugins.filter((entry: unknown) => typeof entry === "object")).toMatchObject(["later", "feed", "gh-pr-status"].map((id) => ({
    package: join(root, `.release/dev/plugins/${id}`), options: { database: join(preview.data, `${id}.sqlite`) },
  })))
})

test("a second preview retains its items and configures only the selected plugin", async () => {
  const root = await fixture()
  const first = await prepareDev(root, ["later"], {})
  const database = join(first.data, "later.sqlite")
  await Bun.write(database, "existing preview data")
  const second = await prepareDev(root, ["later"], {})
  expect(second.data).toBe(first.data)
  expect(await Bun.file(database).text()).toBe("existing preview data")
  const entries = JSON.parse(second.environment.OPENCODE_CLI_CONFIG_CONTENT).plugins.filter((entry: unknown) => typeof entry === "object")
  expect(entries).toHaveLength(1)
  expect(entries[0].package).toBe(join(root, ".release/dev/plugins/later"))
})

test("missing builds and malformed inline settings fail rather than silently dropping configuration", async () => {
  const root = await fixture()
  await rm(join(root, ".release/opcode-cost/dist/tui.js"))
  await expect(prepareDev(root, ["cost"], {})).rejects.toThrow("Missing build")
  await expect(prepareDev(root, ["later"], { OPENCODE_CONFIG_CONTENT: "[]" })).rejects.toThrow("JSON object")
  await expect(prepareDev(root, ["later"], { OPENCODE_CONFIG_CONTENT: '{"plugins":"wrong"}' })).rejects.toThrow("plugins must be an array")
})

async function globalConfig() {
  const root = await mkdtemp(join(tmpdir(), "opcode-dev-global-"))
  temporary.push(root)
  const directory = join(root, "opencode")
  const files = {
    server: join(directory, "opencode.jsonc"),
    cli: join(directory, "cli.json"),
    // Nothing to take out, so it must stay exactly as it is, comments included.
    other: join(directory, "opencode.json"),
  }
  const original = {
    server: `// pinned and configured copies
{
  "model": "example/model",
  "plugins": ["@lidtop/opencode-cost@0.2.3", { "package": "@lidtop/opencode-context", "options": {} }, "@lidtop/opencode-later", "another-plugin"],
}
`,
    cli: JSON.stringify({ plugins: ["@lidtop/opencode-feed"] }),
    other: `// untouched\n{ "plugins": ["@lidtop/opencode-later"] }\n`,
  }
  for (const name of ["server", "cli", "other"] as const) await Bun.write(files[name], original[name])
  return { configs: globalConfigFiles({ XDG_CONFIG_HOME: root }), files, original, state: join(root, "state") }
}

const packages = ["@lidtop/opencode-cost", "@lidtop/opencode-context", "@lidtop/opencode-feed"]

test("a preview takes its plugins' published copies out of global config and restores the files exactly", async () => {
  const { configs, files, original, state } = await globalConfig()
  const published = await suspendPublished(configs, packages, state)
  expect(published.files.sort()).toEqual([files.cli, files.server].sort())
  expect(Bun.JSONC.parse(await Bun.file(files.server).text())).toEqual({ model: "example/model", plugins: ["@lidtop/opencode-later", "another-plugin"] })
  expect(await Bun.file(files.cli).json()).toEqual({ plugins: [] })
  expect(await Bun.file(files.other).text()).toBe(original.other)
  expect(await published.restore()).toEqual([])
  for (const name of ["server", "cli", "other"] as const) expect(await Bun.file(files[name]).text()).toBe(original[name])
})

test("the next preview restores what a killed one left suspended", async () => {
  const { configs, files, original, state } = await globalConfig()
  await suspendPublished(configs, packages, state)
  const next = await suspendPublished(configs, packages, state)
  expect(next.files).toHaveLength(2)
  expect(await Bun.file(files.cli).json()).toEqual({ plugins: [] })
  await next.restore()
  for (const name of ["server", "cli", "other"] as const) expect(await Bun.file(files[name]).text()).toBe(original[name])
})

test("a file changed during the preview keeps the change and gets its published plugins back", async () => {
  const { configs, files, original, state } = await globalConfig()
  const published = await suspendPublished(configs, packages, state)
  // OpenCode saving a setting, or the user adding a plugin.
  await Bun.write(files.server, JSON.stringify({ model: "other/model", plugins: ["another-plugin", "added-during-preview"] }))
  const warnings = await published.restore()
  expect(warnings).toEqual([expect.stringContaining(files.server)])
  expect(Bun.JSONC.parse(await Bun.file(files.server).text())).toEqual({
    model: "other/model",
    plugins: ["another-plugin", "added-during-preview", "@lidtop/opencode-cost@0.2.3", { package: "@lidtop/opencode-context", options: {} }],
  })
  expect(await Bun.file(files.cli).text()).toBe(original.cli)
})
