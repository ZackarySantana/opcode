import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { opencodeBinary, withOpenCodeHost } from "@opcode/core/test-support/opencode-host"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { SessionsRpc } from "../src/rpc"
import type { SearchOutput } from "../src/domain"

if (!opencodeBinary) console.warn("SKIPPED rpc-host.test.ts: no OpenCode binary on PATH or at ~/.opencode/bin/opencode; real RPC validation is untested.")

/** Real host validation happens before JSON encoding; mock handlers/JSON round trips cannot cover it. */
test.skipIf(!opencodeBinary)("[requires OpenCode binary] populated legacy SQLite rows pass the real server RPC output validator and typed client", async () => {
  const paths = (root: string) => ({ legacyDirectory: join(root, "legacy-project"), database: join(root, "legacy.sqlite") })
  await withOpenCodeHost({
    entry: new URL("../src/index.ts", import.meta.url), id: "opcode-sessions",
    async options(root) {
      const { legacyDirectory, database } = paths(root)
      await mkdir(legacyDirectory, { recursive: true })
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
      return { database }
    },
  }, async ({ client, root }) => {
    const { database } = paths(root)
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
  })
}, 45_000)
