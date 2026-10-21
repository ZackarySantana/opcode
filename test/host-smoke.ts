/** Explicit, optional real-host check. Never uses the user's service or databases. */
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { pluginIDs, publicPackageName } from "../scripts/packaging"

const directories = process.argv.slice(2).map((path) => resolve(path))
if (directories.length === 0) throw new Error("Usage: bun test/host-smoke.ts <built-package-directory> […]")
const packages = await Promise.all(directories.map(async (directory) => {
  const manifest = await Bun.file(`${directory}/package.json`).json() as { name: string; exports: Record<string, string | { import?: string; default?: string }> }
  // Package names identify npm artifacts; the host and RPC keep stable runtime IDs.
  const id = pluginIDs.find((id) => publicPackageName(id) === manifest.name)
  if (!id) throw new Error(`Unknown Opcode package ${manifest.name}`)
  const target = manifest.exports["."]
  const entry = typeof target === "string" ? target : target?.import ?? target?.default
  if (!entry) throw new Error(`No server export for ${manifest.name}`)
  return { id: `opcode-${id}`, entry: resolve(directory, entry) }
}))
const expected = packages.map(({ id }) => id)
const executable = Bun.which("opencode")
if (!executable) throw new Error("Install OpenCode V2 to run the optional host smoke check")

await mkdir(tmpdir(), { recursive: true })
const root = await mkdtemp(join(tmpdir(), "host-smoke-"))
const paths = Object.fromEntries(["config", "data", "state", "cache"].map((name) => [name, `${root}/${name}`]))
let server: ReturnType<typeof Bun.spawn> | undefined
let logs = ""
let readers: Promise<void>[] = []
let cleanupTask: Promise<void> | undefined
const shutdown = new AbortController()
const safeLogs = () => logs.replace(/server password \S+/g, "server password [redacted]")
const cleanup = () => cleanupTask ??= (async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM")
    const force = setTimeout(() => { if (server?.exitCode === null) server.kill("SIGKILL") }, 5_000)
    try { await server.exited } finally { clearTimeout(force) }
  }
  await Promise.allSettled(readers)
  await rm(root, { recursive: true, force: true })
})()
const interrupt = (status: number) => {
  shutdown.abort(new Error("Smoke check interrupted"))
  process.exitCode = status
  void cleanup().catch((error) => { console.error(error); process.exitCode = 1 })
}
const onInterrupt = () => interrupt(130)
const onTerminate = () => interrupt(143)
process.on("SIGINT", onInterrupt)
process.on("SIGTERM", onTerminate)
try {
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })))
  // Local V2 directories discover root index files, unlike installed npm exports.
  // Bridge to each packed server export without changing its generated artifact.
  const entries = await Promise.all(packages.map(async ({ id, entry }) => {
    const directory = `${root}/plugins/${id}`
    await mkdir(directory, { recursive: true })
    await Bun.write(`${directory}/index.js`, `export { default } from ${JSON.stringify(pathToFileURL(entry).href)}\n`)
    return directory
  }))
  await Bun.write(`${root}/opencode.json`, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: entries,
  }))
  shutdown.signal.throwIfAborted()
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  reservation.stop(true)
  server = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "debug"], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: paths.config,
      XDG_DATA_HOME: paths.data,
      XDG_STATE_HOME: paths.state,
      XDG_CACHE_HOME: paths.cache,
      OPENCODE_DB: `${root}/opencode.sqlite`,
      OPENCODE_CONFIG: `${root}/opencode.json`,
      OPENCODE_CONFIG_DIR: paths.config,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: entries }),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        logs += decoder.decode(value, { stream: true })
      }
    } finally { reader.releaseLock() }
  }
  readers = [capture(server.stdout as ReadableStream<Uint8Array>), capture(server.stderr as ReadableStream<Uint8Array>)]
  const endpoint = `http://127.0.0.1:${port}/api/plugin?${new URLSearchParams({ "location[directory]": root })}`
  let plugins: { id?: string; state: { status: string; error?: string } }[] | undefined
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted()
    if (server.exitCode !== null) throw new Error(`OpenCode exited (${server.exitCode})\n${safeLogs()}`)
    try {
      const password = /server password (\S+)/.exec(logs)?.[1]
      const headers = password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : undefined
      // Registry reads activate the location runtime; plugin.list alone can be empty before activation.
      await fetch(endpoint.replace("/api/plugin?", "/api/agent?"), { headers, signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]) })
      const response = await fetch(endpoint, { headers, signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(2_000)]) })
      if (response.ok) {
        const result = await response.json() as { data: typeof plugins }
        plugins = result.data
        if (plugins && expected.every((name) => plugins?.some((plugin) => plugin.id === name))) break
      }
    } catch { /* Startup may not have opened the listener yet. */ }
    await Bun.sleep(100)
  }
  if (!plugins) throw new Error(`OpenCode did not become ready\n${safeLogs()}`)
  for (const name of expected) {
    const plugin = plugins.find((item) => item.id === name)
    if (!plugin) throw new Error(`Plugin ${name} did not activate\n${safeLogs()}`)
    if (plugin.state.status !== "active") throw new Error(`Plugin ${name} failed: ${plugin.state.error}\n${safeLogs()}`)
    console.log(`${name}: active`)
  }
  const password = /server password (\S+)/.exec(logs)?.[1]
  const headers = {
    "content-type": "application/json",
    ...(password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}),
  }
  const reads = [
    { id: "opcode-context", method: "tools", body: { input: {} } },
    { id: "opcode-cost", method: "dashboard", body: { input: { range: "all" } } },
    { id: "opcode-sessions", method: "search", body: { input: { query: "", showSubagents: false } } },
  ]
  for (const read of reads.filter(({ id }) => expected.includes(id))) {
    const response = await fetch(endpoint.replace("/api/plugin?", `/api/rpc/${read.id}/${read.method}?`), {
      method: "POST", headers, body: JSON.stringify(read.body), signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]),
    })
    if (!response.ok) throw new Error(`${read.id}.${read.method}: HTTP ${response.status}: ${await response.text()}`)
    const result = await response.json() as { output?: unknown }
    if (result.output === undefined) throw new Error(`${read.id}.${read.method}: missing RPC output`)
    console.log(`${read.id}.${read.method}: valid RPC response`)
  }
} catch (error) {
  if (!shutdown.signal.aborted) throw error
} finally {
  try { await cleanup() } finally {
    process.off("SIGINT", onInterrupt)
    process.off("SIGTERM", onTerminate)
  }
}
