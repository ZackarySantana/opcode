import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { SessionsRpc } from "../src/rpc"
import type { SearchOutput } from "../src/domain"

const installed = join(homedir(), ".opencode", "bin", "opencode")
const executable = Bun.which("opencode") ?? (existsSync(installed) ? installed : undefined)
if (!executable) console.warn("SKIPPED rpc-host.test.ts: no OpenCode binary on PATH or at ~/.opencode/bin/opencode; real RPC validation is untested.")

/** Real host validation happens before JSON encoding; mock handlers/JSON round trips cannot cover it. */
test.skipIf(!executable)("[requires OpenCode binary] populated legacy SQLite rows pass the real server RPC output validator and typed client", async () => {
  const root = await mkdtemp(join(tmpdir(), "sessions-rpc-host-"))
  const plugin = join(root, "plugin")
  const legacyDirectory = join(root, "legacy-project")
  const database = join(root, "legacy.sqlite")
  let server: ReturnType<typeof Bun.spawn> | undefined
  let readers: Promise<void>[] = []
  let logs = ""
  const diagnostics = () => logs.replace(/server password \S+/g, "server password [redacted]").replace(/Basic [A-Za-z0-9+/=]+/g, "Basic [redacted]").slice(-5000)
  try {
    await Promise.all([plugin, legacyDirectory, ...["config", "data", "state", "cache"].map((name) => join(root, name))].map((path) => mkdir(path, { recursive: true })))
    // Installed peers remain external, just as in a published package; only the link lives in the fixture.
    await symlink(new URL("../../../node_modules", import.meta.url).pathname, join(plugin, "node_modules"), "dir")
    const legacy = new Database(database)
    try {
      legacy.run(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,directory TEXT NOT NULL,title TEXT NOT NULL,
          parent_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,indexed_at INTEGER NOT NULL);
        CREATE TABLE messages (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,created_at INTEGER NOT NULL,
          text TEXT NOT NULL,provider_id TEXT,model_id TEXT);
      `)
      const insertSession = legacy.query("INSERT INTO sessions VALUES (?, 'legacy-project', ?, ?, ?, 1, ?, 1)")
      insertSession.run("legacy-root", legacyDirectory, "Legacy root", null, 400)
      insertSession.run("legacy-child", legacyDirectory, "Legacy child", "legacy-root", 300)
      insertSession.run("legacy-partial", legacyDirectory, "Partial model metadata", null, 200)
      insertSession.run("legacy-provider-only", legacyDirectory, "Missing model ID", null, 150)
      insertSession.run("legacy-empty", legacyDirectory, "No model metadata", null, 100)
      const insertMessage = legacy.query("INSERT INTO messages VALUES (?, ?, ?, 2, ?, ?, ?)")
      insertMessage.run("legacy-user", "legacy-root", "user", "Retained legacy root text", null, null)
      insertMessage.run("legacy-assistant", "legacy-child", "assistant", "Retained child text", "fixture-provider", "fixture-model")
      insertMessage.run("legacy-partial-message", "legacy-partial", "assistant", "Partial metadata text", null, "legacy-model")
      insertMessage.run("legacy-provider-message", "legacy-provider-only", "assistant", "Missing model ID text", "fixture-provider", null)
    } finally { legacy.close() }

    const built = await Bun.build({
      entrypoints: [new URL("../src/index.ts", import.meta.url).pathname], outdir: plugin, target: "bun", format: "esm",
      external: ["@opencode/plugin", "@opencode/plugin/rpc", "@opencode/client"],
    })
    if (!built.success) throw new AggregateError(built.logs, "Could not build the real sessions server fixture")
    const config = { $schema: "https://opencode.ai/config.json", plugins: [{ package: plugin, options: { database } }] }
    await Bun.write(join(root, "opencode.json"), JSON.stringify(config))
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = reservation.port
    reservation.stop(true)
    const running = Bun.spawn([executable!, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "debug"], {
      cwd: root,
      // No user config, credentials, service, or database is inherited by this disposable host.
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
    let client: ReturnType<typeof OpenCode.make> | undefined
    let startupError = ""
    let lastPlugins: unknown
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (running.exitCode !== null) throw new Error(`Isolated OpenCode exited with status ${running.exitCode}`)
      const password = /server password (\S+)/.exec(logs)?.[1]
      const candidate = OpenCode.make({ baseUrl, headers: password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {} })
      await candidate.agent.list({ location: { directory: root } }, { signal: AbortSignal.timeout(1_000) }).catch(() => undefined)
      const plugins = await candidate.plugin.list({ location: { directory: root } }, { signal: AbortSignal.timeout(1_000) }).catch((error: unknown) => { startupError = error instanceof Error ? error.message : String(error); return undefined })
      lastPlugins = plugins
      const failed = plugins?.data.find((item) => item.state.status === "failed")
      if (failed?.state.status === "failed") throw new Error(`Isolated sessions plugin failed: ${failed.state.error}\n${diagnostics()}`)
      const sessions = plugins?.data.find((item) => item.id === "opcode-sessions")
      if (sessions?.state.status === "failed") throw new Error(`Isolated sessions plugin failed: ${sessions.state.error}`)
      if (sessions?.state.status === "active") { client = candidate; break }
      await Bun.sleep(50)
    }
    if (!client) throw new Error(`Isolated sessions plugin did not activate: ${startupError}; ${JSON.stringify(lastPlugins)}\n${diagnostics()}`)
    const rpc = client.rpc(SessionsRpc)
    const options = { location: { directory: root }, signal: AbortSignal.timeout(5_000) }
    const result = await rpc.search({ query: "", showSubagents: true }, options) as SearchOutput
    expect(result.rows.map((row) => row.id)).toEqual(["legacy-root", "legacy-child", "legacy-partial", "legacy-provider-only", "legacy-empty"])
    const [rootRow, child, partial, providerOnly, empty] = result.rows
    expect(rootRow).toMatchObject({ snippet: "Retained legacy root text", messageCount: 1, modelCount: 0, cost: 0 })
    for (const row of [rootRow!, providerOnly!, empty!]) {
      for (const key of ["parentID", "providerID", "modelID"] as const) expect(Object.hasOwn(row, key)).toBe(false)
    }
    expect(child).toMatchObject({ parentID: "legacy-root", providerID: "fixture-provider", modelID: "fixture-model", snippet: "Retained child text" })
    expect(partial?.modelID).toBe("legacy-model")
    expect(Object.hasOwn(partial!, "providerID")).toBe(false)
    expect(result.truncated).toBe(false)
    // Exercises the bundled regex worker and per-field anchors in the real server.
    const matched = await rpc.search({ query: "^Retained legacy", showSubagents: true }, options) as SearchOutput
    expect(matched.rows.map((row) => row.id)).toEqual(["legacy-root"])
    const rootsOnly = await rpc.search({ query: "", showSubagents: false }, options) as SearchOutput
    expect(rootsOnly.rows.map((row) => row.id)).toEqual(["legacy-root", "legacy-partial", "legacy-provider-only", "legacy-empty"])
    const persisted = new Database(database, { readonly: true })
    try {
      expect(persisted.query("SELECT parent_id FROM sessions WHERE id='legacy-root'").get()).toEqual({ parent_id: null })
      expect(persisted.query("SELECT provider_id,model_id FROM messages WHERE id='legacy-partial-message'").get()).toEqual({ provider_id: null, model_id: "legacy-model" })
      expect(persisted.query("SELECT provider_id,model_id FROM messages WHERE id='legacy-provider-message'").get()).toEqual({ provider_id: "fixture-provider", model_id: null })
    } finally { persisted.close() }
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM")
      const force = setTimeout(() => { if (server?.exitCode === null) server.kill("SIGKILL") }, 5_000)
      try { await server.exited } finally { clearTimeout(force) }
    }
    await Promise.allSettled(readers)
    await rm(root, { recursive: true, force: true })
  }
}, 45_000)
