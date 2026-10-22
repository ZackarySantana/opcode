import { appendFile, mkdir, readdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { manifestAt, pluginIDs, publicPackageName, repositoryRoot, run } from "./packaging"

export type PublishOperations = {
  environment: Record<string, string | undefined>
  command: (args: string[], cwd: string) => Promise<string>
  build: (root: string) => Promise<void>
  registryStatus: (url: string) => Promise<number>
  sleep: (ms: number) => Promise<void>
}

export type Tarball = { name: string; version: string; tarball: string }

function operations(overrides: Partial<PublishOperations>): PublishOperations {
  return {
    environment: process.env,
    command: (args, cwd) => run(args, cwd, { echo: true }),
    // Loaded lazily: publishing prebuilt tarballs must not need build dependencies installed.
    build: async (root) => (await import("./build")).buildAll(root),
    registryStatus: async (url) => (await fetch(url)).status,
    sleep: (ms) => Bun.sleep(ms),
    ...overrides,
  }
}

/** Builds and packs every plugin into `.release/tarballs`, without contacting npm. */
export async function pack(root = repositoryRoot, overrides: Partial<PublishOperations> = {}): Promise<Tarball[]> {
  const { build, command } = operations(overrides)
  await build(root)
  const tarballs = join(root, ".release/tarballs")
  await rm(tarballs, { recursive: true, force: true })
  await mkdir(tarballs, { recursive: true })
  const packed: Tarball[] = []
  for (const id of pluginIDs) {
    const directory = join(root, ".release", `opcode-${id}`)
    const manifest = await manifestAt(directory)
    if (manifest.name !== publicPackageName(id) || manifest.private) throw new Error(`Invalid public plugin manifest: ${directory}`)
    const output = JSON.parse(await command(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", tarballs], directory)) as { filename: string }[]
    const tarball = join(tarballs, output[0]!.filename)
    console.log(`Packed ${manifest.name}@${manifest.version}: ${tarball} (not published)`)
    packed.push({ name: manifest.name, version: manifest.version, tarball })
  }
  return packed
}

/** The manifests inside prebuilt tarballs; exactly one per public plugin. */
export async function readTarballs(directory: string, overrides: Partial<PublishOperations> = {}): Promise<Tarball[]> {
  const { command } = operations(overrides)
  const found = new Map<string, Tarball>()
  for (const file of (await readdir(directory)).filter((file) => file.endsWith(".tgz")).sort()) {
    const tarball = join(directory, file)
    const manifest = JSON.parse(await command(["tar", "-xzOf", tarball, "package/package.json"], directory))
    if (!pluginIDs.some((id) => publicPackageName(id) === manifest.name) || manifest.private || typeof manifest.version !== "string") {
      throw new Error(`Unexpected package in ${file}`)
    }
    if (found.has(manifest.name)) throw new Error(`Multiple tarballs for ${manifest.name}`)
    found.set(manifest.name, { name: manifest.name, version: manifest.version, tarball })
  }
  return pluginIDs.map((id) => {
    const tarball = found.get(publicPackageName(id))
    if (!tarball) throw new Error(`Missing tarball for ${publicPackageName(id)} in ${directory}`)
    return tarball
  })
}

/** Exact-version lookup that fails closed on anything except published or 404. */
async function isPublished({ name, version }: Tarball, registryStatus: PublishOperations["registryStatus"]) {
  const status = await registryStatus(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`)
  if (status >= 200 && status < 300) return true
  if (status !== 404) throw new Error(`Registry lookup failed for ${name}: HTTP ${status}`)
  return false
}

const RETRY_DELAYS = [5_000, 15_000]

/** Registry 5xx and network failures; auth, conflict, and validation errors are never retried. */
function transient(error: unknown) {
  return /\bcode E5\d\d\b|\b5\d\d (?:Service Unavailable|Bad Gateway|Gateway Time-?out|Internal Server Error)\b|\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE)\b|socket hang up/i.test(String(error))
}

/** A failed PUT may still have landed, so re-check the exact version before each retry. */
async function publishOne(tarball: Tarball, directory: string, { command, registryStatus, sleep }: PublishOperations) {
  for (let attempt = 0; ; attempt++) {
    try {
      console.log(await command(["npm", "publish", tarball.tarball, "--access", "public", "--provenance", "--ignore-scripts", "--registry", "https://registry.npmjs.org/"], directory))
      return
    } catch (error) {
      if (!transient(error)) throw error
      if (await isPublished(tarball, registryStatus)) {
        console.log(`${tarball.name}@${tarball.version} was published despite a registry error`)
        return
      }
      const delay = RETRY_DELAYS[attempt]
      if (delay === undefined) throw error
      console.error(`Transient registry failure publishing ${tarball.name}@${tarball.version}; retrying in ${delay / 1000}s`)
      await sleep(delay)
    }
  }
}

/** Read-only: which tarball versions npm does not have yet, exposed as the `packages` step output. */
export async function unpublished(directory: string, overrides: Partial<PublishOperations> = {}): Promise<Tarball[]> {
  const { environment, registryStatus } = operations(overrides)
  const pending: Tarball[] = []
  for (const tarball of await readTarballs(directory, overrides)) {
    if (!await isPublished(tarball, registryStatus)) pending.push(tarball)
  }
  const names = pending.map(({ name, version }) => `${name}@${version}`)
  console.log(names.length ? `Unpublished: ${names.join(" ")}` : "All staged versions are already published")
  if (environment.GITHUB_OUTPUT) await appendFile(environment.GITHUB_OUTPUT, `packages=${JSON.stringify(names)}\n`)
  return pending
}

/** Publishes prebuilt tarballs only; reruns skip exact versions already on npm. */
export async function publishTarballs(directory: string, overrides: Partial<PublishOperations> = {}): Promise<Tarball[]> {
  const resolved = operations(overrides)
  const { environment, command, registryStatus } = resolved
  if (environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_REF !== "refs/heads/main" || !environment.ACTIONS_ID_TOKEN_REQUEST_URL) {
    throw new Error("Live publishing requires the main-branch GitHub Actions OIDC environment")
  }
  const version = /^11\.(\d+)\.(\d+)$/.exec((await command(["npm", "--version"], directory)).trim())
  if (!version || Number(version[1]) < 5 || (Number(version[1]) === 5 && Number(version[2]) < 1)) throw new Error("Publishing requires npm 11.5.1+ (11.x) and Node 24")
  const nodeVersion = (await command(["node", "--version"], directory)).trim()
  if (!/^v24\.\d+\.\d+$/.test(nodeVersion)) throw new Error("Publishing requires Node 24")
  const published: Tarball[] = []
  for (const tarball of await readTarballs(directory, overrides)) {
    if (await isPublished(tarball, registryStatus)) {
      console.log(`Skipping published ${tarball.name}@${tarball.version}`)
      continue
    }
    await publishOne(tarball, directory, resolved)
    published.push(tarball)
  }
  return published
}

if (import.meta.main) {
  const usage = "Usage: bun scripts/publish.ts [--dry-run] | --pending --from <dir> | --publish --from <dir>"
  const [mode = "--dry-run", ...rest] = process.argv.slice(2)
  if (mode === "--dry-run" && !rest.length) await pack()
  else if ((mode === "--pending" || mode === "--publish") && rest.length === 2 && rest[0] === "--from") {
    await (mode === "--pending" ? unpublished : publishTarballs)(resolve(rest[1]!))
  } else throw new Error(usage)
}
