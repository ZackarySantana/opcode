import { join } from "node:path"
import { claimGlobalConfig, globalConfigFiles, packageOf, selectPlugins } from "./dev"
import { publicPackageName, repositoryRoot } from "./packaging"

type Environment = Record<string, string | undefined>
type Install = (name: string) => Promise<number>

/** `opencode plugin add`, the install command every plugin's README gives. */
function opencodeInstall(environment: Environment): Install {
  const executable = Bun.which("opencode", { PATH: environment.PATH })
  if (!executable) throw new Error("Install OpenCode V2 first, then run mise run prod again.")
  return (name) => Bun.spawn([executable, "plugin", "add", name], { env: environment, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited
}

/**
 * Packages configured in any global file, at any version or with options. `opencode plugin add` checks only exact
 * entries in opencode.json(c), so it would add a second copy of a pinned plugin or of one configured in cli.json.
 */
async function configuredPackages(files: readonly string[]): Promise<Set<string>> {
  const configured = new Set<string>()
  for (const path of files) {
    const text = await Bun.file(path).text().catch(() => undefined)
    if (text === undefined) continue
    let plugins: unknown
    try { plugins = (Bun.JSONC.parse(text) as { plugins?: unknown } | undefined)?.plugins }
    catch (error) { throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : error}`) }
    if (Array.isArray(plugins)) for (const entry of plugins) configured.add(packageOf(entry))
  }
  return configured
}

/** Installs the published plugins missing from global config, leaving configured ones as they are. */
export async function prod(arguments_: string[], root = repositoryRoot, environment: Environment = process.env, install = opencodeInstall(environment)) {
  const packages = selectPlugins(arguments_).map(publicPackageName)
  const files = globalConfigFiles(environment)
  // Holding global config keeps a preview from taking entries out mid-install.
  const claim = await claimGlobalConfig(files, join(root, ".release/dev/config"))
  try {
    for (const warning of claim.warnings) console.warn(warning)
    const configured = await configuredPackages(files)
    const missing = packages.filter((name) => !configured.has(name))
    for (const name of missing) {
      const status = await install(name)
      if (status !== 0) return status
    }
    const kept = packages.filter((name) => configured.has(name))
    if (kept.length) console.log(`Already in your global config, left as is: ${kept.join(", ")}.`)
    if (missing.length) console.log("Restart OpenCode if the new plugins don't appear.")
    return 0
  } finally { await claim.release() }
}

if (import.meta.main) {
  try { process.exitCode = await prod(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}
