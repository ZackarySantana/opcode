import { mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import { pluginEntries, pluginIDs, publicPackageName, repositoryRoot } from "./packaging"

type PluginID = typeof pluginIDs[number]
// Client-local plugins load through the CLI config so their options reach the terminal process: a server-loaded
// terminal side gets none. A plugin in both configs loads its terminal side once, from the CLI config.
// Later's server side registers its agent tools, so it is in both.
const clientLocal: readonly PluginID[] = ["later"]
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

/** Prepare only checkout-owned files. Existing databases are never edited; see suspendPublished for global config. */
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
    // Server-only plugins have no terminal side to load.
    const sides = pluginEntries(join(root, "plugins", id)).filter((entry) => entry !== "rpc.ts").map((entry) => entry.replace(/\.tsx?$/, ""))
    for (const entry of sides) {
      if (!await Bun.file(join(source, `${entry}.js`)).exists()) throw new Error(`Missing build for opcode-${id}. Run mise run build first.`)
    }
    // Start clean, so a side the plugin no longer has isn't loaded from an old wrapper.
    await rm(wrapper, { recursive: true, force: true })
    await mkdir(wrapper, { recursive: true, mode: 0o700 })
    // Local V2 directories discover root entrypoints, rather than npm exports.
    for (const entry of sides) {
      await Bun.write(join(wrapper, `${entry}.js`), `export { default } from ${JSON.stringify(pathToFileURL(join(source, `${entry}.js`)).href)}\n`)
    }
    entries.push({ id, entry: { package: wrapper, options: { database: join(data, `${id}.sqlite`) } } })
  }
  const disabled = [...originals, ...pluginIDs.map((id) => `opcode-${id}`)].map((id) => `-${id}`)
  const local = entries.filter(({ id }) => clientLocal.includes(id)).map(({ entry }) => entry)
  const shared = entries.map(({ entry }) => entry)
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

/** Global server and CLI config, where published copies of the plugins are usually installed. */
export function globalConfigFiles(environment: Environment): string[] {
  const directory = join(environment.XDG_CONFIG_HOME || join(environment.HOME || homedir(), ".config"), "opencode")
  return ["opencode.json", "opencode.jsonc", "cli.json"].map((name) => join(directory, name))
}

/** The package an entry installs, without its version: "@scope/name@1.0.0" is "@scope/name". */
export function packageOf(entry: unknown): string {
  const spec = typeof entry === "string" ? entry : (entry as { package?: unknown } | null)?.package
  return typeof spec === "string" ? spec.replace(/(?!^)@.*$/, "") : ""
}

const read = (path: string) => Bun.file(path).text().catch(() => undefined)
const plugins = (text: string) => (Bun.JSONC.parse(text) as { plugins?: unknown[] }).plugins ?? []
// Backups can hold provider keys from the config they copy.
const save = (path: string, text: string) => writeFile(path, text, { mode: 0o600 })

/** A suspended file's original, and what the preview wrote in its place. */
function backupOf(path: string, directory: string) {
  const original = join(directory, basename(path))
  return { original, written: `${original}.preview` }
}

/**
 * Puts a suspended file back: exactly as it was, or, if it changed during the preview (OpenCode saves settings
 * there too), with the removed entries added to the changed version. Returns a warning when it can't be exact.
 */
async function resume(path: string, directory: string): Promise<string | undefined> {
  const backup = backupOf(path, directory)
  const [current, original, written] = await Promise.all([read(path), read(backup.original), read(backup.written)])
  if (original === undefined || written === undefined) return
  let warning: string | undefined
  if (current !== original) {
    if (current === undefined || current === written) await save(path, original)
    else {
      const kept = new Set(plugins(written).map((entry) => JSON.stringify(entry)))
      const removed = plugins(original).filter((entry) => !kept.has(JSON.stringify(entry)))
      await save(path, `${JSON.stringify({ ...Bun.JSONC.parse(current) as object, plugins: [...plugins(current), ...removed] }, null, 2)}\n`)
      warning = `${path} changed during the preview, so its published Opcode plugins were added back to your changes; comments from before the preview are in ${backup.original}.`
    }
  }
  await rm(backup.written)
  if (!warning) await rm(backup.original)
  return warning
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/**
 * Holds global config for this process, refusing while another live preview or install has it, then puts back what
 * a killed preview left suspended, so nothing is written over it. `release` gives the config up.
 */
export async function claimGlobalConfig(files: readonly string[], directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lock = join(directory, "pid")
  const owner = Number(await read(lock))
  if (owner && owner !== process.pid && alive(owner)) throw new Error(`Another Opcode preview or install (PID ${owner}) has your global config. Exit it first.`)
  await save(lock, String(process.pid))
  const warnings: string[] = []
  for (const path of files) { const warning = await resume(path, directory); if (warning) warnings.push(warning) }
  return { warnings, release: () => rm(lock, { force: true }) }
}

/**
 * OpenCode imports every plugin entry before applying `-id` removals, so a published copy of a previewed plugin in
 * global config collides with the local one and fails to load. Take those entries out for the preview, and put them
 * back with `restore`. Backups in `directory` let the next preview restore what a killed one left behind.
 */
export async function suspendPublished(files: readonly string[], packages: readonly string[], directory: string) {
  const { warnings, release } = await claimGlobalConfig(files, directory)
  const restore = async () => {
    for (const path of files) {
      try { const warning = await resume(path, directory); if (warning) warnings.push(warning) }
      catch (error) { warnings.push(`Could not restore ${path}: ${error instanceof Error ? error.message : error}. Its original is in ${backupOf(path, directory).original}.`) }
    }
    await release()
    return warnings.splice(0)
  }
  const suspended: string[] = []
  try {
    for (const path of files) {
      const original = await read(path)
      if (original === undefined) continue
      const config = Bun.JSONC.parse(original) as { plugins?: unknown }
      if (!Array.isArray(config.plugins)) continue
      const kept = config.plugins.filter((entry) => !packages.includes(packageOf(entry)))
      if (kept.length === config.plugins.length) continue
      const backup = backupOf(path, directory)
      const written = `${JSON.stringify({ ...config, plugins: kept }, null, 2)}\n`
      // The preview copy marks a suspension, so it is written after the original it restores.
      await save(backup.original, original)
      await save(backup.written, written)
      await save(path, written)
      suspended.push(path)
    }
  } catch (error) {
    await restore()
    throw new Error(`Could not take published Opcode plugins out of global config: ${error instanceof Error ? error.message : error}`)
  }
  return { files: suspended, warnings: warnings.splice(0), restore }
}

/** Keep the terminal attached and forward external termination without orphaning OpenCode. */
async function attached(command: string[], cwd: string, environment: Environment) {
  const child = Bun.spawn(command, { cwd, env: environment, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  let interrupted: number | undefined
  let force: ReturnType<typeof setTimeout> | undefined
  const stop = (signal: "SIGINT" | "SIGTERM" | "SIGHUP", status: number) => {
    interrupted = status
    if (child.exitCode !== null) return
    child.kill(signal)
    force ??= setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL") }, 5_000)
  }
  const interrupt = () => stop("SIGINT", 130)
  const terminate = () => stop("SIGTERM", 143)
  const hangup = () => stop("SIGHUP", 129)
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  process.on("SIGHUP", hangup)
  try {
    const status = await child.exited
    return interrupted ?? status
  } finally {
    if (force) clearTimeout(force)
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
    process.off("SIGHUP", hangup)
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
  const packages = selected.map(publicPackageName)
  const published = await suspendPublished(globalConfigFiles(environment), packages, join(root, ".release/dev/config"))
  for (const warning of published.warnings) console.warn(warning)
  const suspended = published.files.length
    ? `Took ${packages.join(", ")} out of ${published.files.join(", ")} until OpenCode exits; other OpenCode windows lose them meanwhile.`
    : "Global config files are unchanged."
  console.log(`\nOpcode preview: ${selected.join(", ")}\nPlugin databases: ${preview.data}\nUsing your normal OpenCode login/session database. ${suspended}\nTry /context, /cost, /later, /feed, /ghpr, /snippets, /review, or /sessions-all.\n`)
  try { return await attached([executable, "--standalone"], root, preview.environment) }
  finally {
    for (const warning of await published.restore()) console.warn(warning)
    if (published.files.length) console.log(`Restored ${published.files.join(", ")}.`)
  }
}

if (import.meta.main) {
  try { process.exitCode = await dev(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}
