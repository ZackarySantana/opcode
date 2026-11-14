import { OpenCode } from "@opencode/client"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const installed = join(homedir(), ".opencode", "bin", "opencode")

/** The OpenCode binary on PATH or at ~/.opencode/bin/opencode; tests against a real host skip without one. */
export const opencodeBinary = Bun.which("opencode") ?? (existsSync(installed) ? installed : undefined)

export interface OpenCodeHost {
  readonly client: ReturnType<typeof OpenCode.make>
  /** The host's working directory, and every directory it uses. */
  readonly root: string
}

/**
 * Runs `use` against a disposable OpenCode server with one plugin active, built from its server `entry`: the host's
 * own RPC validation, which a fake server's JSON round trip can't cover. Nothing is inherited from the user: no config,
 * credentials, data, or environment beyond PATH. `options` makes the plugin's options in the host's directory first.
 */
export async function withOpenCodeHost<T>(plugin: {
  entry: URL
  id: string
  options?(root: string): Promise<Record<string, unknown>> | Record<string, unknown>
}, use: (host: OpenCodeHost) => Promise<T>): Promise<T> {
  if (!opencodeBinary) throw new Error("No OpenCode binary: skip the test with test.skipIf(!opencodeBinary)")
  const root = await mkdtemp(join(tmpdir(), `${plugin.id}-host-`))
  const directory = join(root, "plugin")
  let server: ReturnType<typeof Bun.spawn> | undefined
  let readers: Promise<void>[] = []
  let logs = ""
  const diagnostics = () => logs.replace(/server password \S+/g, "server password [redacted]").replace(/Basic [A-Za-z0-9+/=]+/g, "Basic [redacted]").slice(-5000)
  try {
    await Promise.all([directory, ...["config", "data", "state", "cache"].map((name) => join(root, name))].map((path) => mkdir(path, { recursive: true })))
    // Installed peers remain external, just as in a published package; only the link lives in the fixture.
    await symlink(new URL("../../../node_modules", import.meta.url).pathname, join(directory, "node_modules"), "dir")
    const built = await Bun.build({
      entrypoints: [plugin.entry.pathname], outdir: directory, target: "bun", format: "esm",
      external: ["@opencode/plugin", "@opencode/plugin/rpc", "@opencode/client"],
    })
    if (!built.success) throw new AggregateError(built.logs, `Could not build the ${plugin.id} server fixture`)
    const config = { $schema: "https://opencode.ai/config.json", plugins: [{ package: directory, options: await plugin.options?.(root) ?? {} }] }
    await Bun.write(join(root, "opencode.json"), JSON.stringify(config))
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = reservation.port
    reservation.stop(true)
    const running = Bun.spawn([opencodeBinary, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "debug"], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "", HOME: root,
        XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_DB: join(root, "host.sqlite"), OPENCODE_CONFIG: join(root, "opencode.json"),
        OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      stdout: "pipe", stderr: "pipe",
    })
    server = running
    const capture = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          logs += decoder.decode(next.value, { stream: true })
        }
      } finally { reader.releaseLock() }
    }
    readers = [capture(running.stdout), capture(running.stderr)]
    const baseUrl = `http://127.0.0.1:${port}`
    let client: OpenCodeHost["client"] | undefined
    let startupError = ""
    let lastPlugins: unknown
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (running.exitCode !== null) throw new Error(`Isolated OpenCode exited with status ${running.exitCode}\n${diagnostics()}`)
      const password = /server password (\S+)/.exec(logs)?.[1]
      const candidate = OpenCode.make({ baseUrl, headers: password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {} })
      await candidate.agent.list({ location: { directory: root } }, { signal: AbortSignal.timeout(1_000) }).catch(() => undefined)
      const plugins = await candidate.plugin.list({ location: { directory: root } }, { signal: AbortSignal.timeout(1_000) }).catch((error: unknown) => { startupError = error instanceof Error ? error.message : String(error); return undefined })
      lastPlugins = plugins
      const failed = plugins?.data.find((item) => item.state.status === "failed")
      if (failed?.state.status === "failed") throw new Error(`Isolated plugin failed: ${failed.state.error}\n${diagnostics()}`)
      if (plugins?.data.find((item) => item.id === plugin.id)?.state.status === "active") { client = candidate; break }
      await Bun.sleep(50)
    }
    if (!client) throw new Error(`Isolated ${plugin.id} plugin did not activate: ${startupError}; ${JSON.stringify(lastPlugins)}\n${diagnostics()}`)
    return await use({ client, root })
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM")
      const force = setTimeout(() => { if (server?.exitCode === null) server.kill("SIGKILL") }, 5_000)
      try { await server.exited } finally { clearTimeout(force) }
    }
    await Promise.allSettled(readers)
    await rm(root, { recursive: true, force: true })
  }
}
