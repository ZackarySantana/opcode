import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { pluginIDs, publicPackageName, repositoryRoot } from "./packaging"

type PluginID = typeof pluginIDs[number]
// Client-local plugins load through the CLI config so their options reach the terminal process.
const clientLocal: readonly PluginID[] = ["later", "feed"]
type Environment = Record<string, string | undefined>
const originals = ["opencode-context-tui", "opencode-cost", "opencode-later", "opencode-sessions-all"]

export function selectPlugins(arguments_: string[]): PluginID[] {
  if (!arguments_.length) return [...pluginIDs]
  return [...new Set(arguments_.map((argument) => {
    const id = pluginIDs.find((id) => argument === id || argument === `opcode-${id}` || argument === publicPackageName(id))
    if (!id) throw new Error(`Unknown plugin '${argument}'. Choose: ${pluginIDs.join(", ")}`)
    return id
  }))]
}

function inlineSettings(value: string | undefined, name: string): Record<string, unknown> {
  if (!value) return {}
  const settings: unknown = JSON.parse(value)
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${name} must contain a JSON object`)
  return settings as Record<string, unknown>
}

/** Prepare only checkout-owned files. Global config and existing databases are never edited. */
export async function prepareDev(root: string, selected: PluginID[], environment: Environment, directory = join(root, ".release/dev")): Promise<{
  data: string
  environment: Environment & { OPENCODE_CONFIG_CONTENT: string; OPENCODE_CLI_CONFIG_CONTENT: string }
}> {
  const settings = inlineSettings(environment.OPENCODE_CONFIG_CONTENT, "OPENCODE_CONFIG_CONTENT")
  const cli = inlineSettings(environment.OPENCODE_CLI_CONFIG_CONTENT, "OPENCODE_CLI_CONFIG_CONTENT")
  if (settings.plugins !== undefined && !Array.isArray(settings.plugins)) throw new Error("Inline plugins must be an array")
  const data = join(directory, "data")
  await mkdir(data, { recursive: true, mode: 0o700 })
  const entries = []
  for (const id of selected) {
    const source = join(root, ".release", `opcode-${id}`, "dist")
    const wrapper = join(directory, "plugins", id)
    for (const entry of ["index", "tui"]) {
      if (!await Bun.file(join(source, `${entry}.js`)).exists()) throw new Error(`Missing build for opcode-${id}. Run mise run build first.`)
    }
    await mkdir(wrapper, { recursive: true, mode: 0o700 })
    // Local V2 directories discover root entrypoints, rather than npm exports.
    for (const entry of ["index", "tui"]) {
      await Bun.write(join(wrapper, `${entry}.js`), `export { default } from ${JSON.stringify(pathToFileURL(join(source, `${entry}.js`)).href)}\n`)
    }
    entries.push({ id, entry: { package: wrapper, options: { database: join(data, `${id}.sqlite`) } } })
  }
  const disabled = [...originals, ...pluginIDs.map((id) => `opcode-${id}`)].map((id) => `-${id}`)
  const local = entries.filter(({ id }) => clientLocal.includes(id)).map(({ entry }) => entry)
  const shared = entries.filter(({ id }) => !clientLocal.includes(id)).map(({ entry }) => entry)
  return {
    data,
    environment: {
      ...environment,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...settings, plugins: [...(settings.plugins as unknown[] ?? []), ...disabled, ...shared] }),
      // Use the server-provided extensions, excluding old CLI-only copies too.
      // Theme, keybinds, and other CLI settings remain inherited.
      OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ ...cli, plugins: ["*", ...originals.map((id) => `-${id}`), ...local] }),
    },
  }
}

/** Keep the terminal attached and forward external termination without orphaning OpenCode. */
async function attached(command: string[], cwd: string, environment: Environment) {
  const child = Bun.spawn(command, { cwd, env: environment, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  let interrupted: number | undefined
  let force: ReturnType<typeof setTimeout> | undefined
  const stop = (signal: "SIGINT" | "SIGTERM", status: number) => {
    interrupted = status
    if (child.exitCode !== null) return
    child.kill(signal)
    force ??= setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL") }, 5_000)
  }
  const interrupt = () => stop("SIGINT", 130)
  const terminate = () => stop("SIGTERM", 143)
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  try {
    const status = await child.exited
    return interrupted ?? status
  } finally {
    if (force) clearTimeout(force)
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
}

export async function dev(arguments_: string[], root = repositoryRoot, environment: Environment = process.env) {
  if (arguments_.includes("--help")) {
    console.log(`Usage: mise run dev [${pluginIDs.join("|")} …]\nDefaults to every plugin. Plugin preview data persists under .release/dev/data.`)
    return 0
  }
  const selected = selectPlugins(arguments_)
  const executable = Bun.which("opencode", { PATH: environment.PATH })
  if (!executable) throw new Error("Install OpenCode V2 first, then run mise run dev again.")
  const installed = await attached([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], root, environment)
  if (installed !== 0) return installed
  // Install first so a fresh checkout needs no separate dependency/setup command.
  const { buildPlugin } = await import("./build")
  for (const id of selected) await buildPlugin(root, id)
  const preview = await prepareDev(root, selected, environment)
  console.log(`\nOpcode preview: ${selected.join(", ")}\nPlugin databases: ${preview.data}\nUsing your normal OpenCode login/session database; global config files are unchanged.\nTry /context, /cost, /later, /feed, or /opcode-sessions. Exit OpenCode normally when done.\n`)
  return attached([executable, "--standalone"], root, preview.environment)
}

if (import.meta.main) {
  try { process.exitCode = await dev(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}
