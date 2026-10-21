import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { buildAll } from "./build"
import { manifestAt, pluginIDs, repositoryRoot } from "./packaging"

async function command(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status) throw new Error(`${args.join(" ")} failed: ${stderr}\n${stdout}`)
  if (stderr) console.error(stderr.trim())
  return stdout
}

export type PublishOperations = {
  environment: Record<string, string | undefined>
  command: typeof command
  build: (root: string) => Promise<void>
  registryStatus: (url: string) => Promise<number>
}

/** No network writes unless explicitly requested; reruns skip exact versions already on npm. */
export async function publish(root = repositoryRoot, live = false, overrides: Partial<PublishOperations> = {}) {
  const operations: PublishOperations = {
    environment: process.env,
    command,
    build: buildAll,
    registryStatus: async (url) => (await fetch(url)).status,
    ...overrides,
  }
  const npm = (args: string[], cwd: string) => operations.command(["npm", ...args], cwd)
  if (live) {
    const environment = operations.environment
    if (environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_REF !== "refs/heads/main" || !environment.ACTIONS_ID_TOKEN_REQUEST_URL) {
      throw new Error("Live publishing requires the main-branch GitHub Actions OIDC environment")
    }
    const version = /^11\.(\d+)\.(\d+)$/.exec((await npm(["--version"], root)).trim())
    if (!version || Number(version[1]) < 5 || (Number(version[1]) === 5 && Number(version[2]) < 1)) throw new Error("Publishing requires npm 11.5.1+ (11.x) and Node 24")
    const nodeVersion = (await operations.command(["node", "--version"], root)).trim()
    if (!/^v24\.\d+\.\d+$/.test(nodeVersion)) throw new Error("Publishing requires Node 24")
  }
  await operations.build(root)
  const tarballs = join(root, ".release/tarballs")
  await mkdir(tarballs, { recursive: true })
  const published: { name: string; version: string }[] = []
  for (const id of pluginIDs) {
    const directory = join(root, ".release", `opcode-${id}`)
    const manifest = await manifestAt(directory)
    const packed = JSON.parse(await npm(["pack", "--json", "--ignore-scripts", "--pack-destination", tarballs], directory)) as { filename: string }[]
    const tarball = join(tarballs, packed[0]!.filename)
    if (!live) {
      console.log(`Packed ${manifest.name}@${manifest.version}: ${tarball} (not published)`)
      continue
    }
    const status = await operations.registryStatus(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`)
    if (status >= 200 && status < 300) {
      console.log(`Skipping published ${manifest.name}@${manifest.version}`)
      continue
    }
    if (status !== 404) throw new Error(`Registry lookup failed for ${manifest.name}: HTTP ${status}`)
    console.log(await npm(["publish", tarball, "--access", "public", "--provenance", "--ignore-scripts", "--registry", "https://registry.npmjs.org/"], directory))
    published.push({ name: manifest.name, version: manifest.version })
  }
  if (operations.environment.GITHUB_OUTPUT) await appendFile(operations.environment.GITHUB_OUTPUT, `publishedPackages=${JSON.stringify(published)}\n`)
  return published
}

if (import.meta.main) {
  if (process.argv.slice(2).some((argument) => argument !== "--publish" && argument !== "--dry-run")) throw new Error("Usage: bun scripts/publish.ts [--dry-run | --publish]")
  if (process.argv.includes("--publish") && process.argv.includes("--dry-run")) throw new Error("Choose --publish or --dry-run")
  await publish(repositoryRoot, process.argv.includes("--publish"))
}
