import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { createSerialQueue } from "@opcode/core"
import type { MessageRecord, ProjectOption, SearchInput, SessionRecord, SessionResult } from "./domain"
import { RegexMatcher, validateQuery } from "./regex"

type StoredSession = Omit<SessionRecord, "parentID"> & { parentID: string | null }

export function databasePath(configured?: unknown, env = process.env, home = homedir()) {
  const state = join(env.XDG_STATE_HOME || join(home, ".local", "state"), "opencode")
  if (typeof configured === "string" && configured.trim()) {
    const path = configured.trim()
    return path === ":memory:" || isAbsolute(path) ? path : resolve(state, path)
  }
  return join(state, "opencode-sessions-all", "sessions.sqlite")
}

/** Original tables/columns remain intact; new metadata guards stale writes and deletions. */
export class SessionIndex {
  readonly db: Database
  constructor(path: string) {
    const fresh = path !== ":memory:" && !existsSync(path)
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true, strict: true })
    if (fresh) chmodSync(path, 0o600)
    this.db.run("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
        parent_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL,
        created_at INTEGER NOT NULL, text TEXT NOT NULL, provider_id TEXT, model_id TEXT,
        cost REAL NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS backfill (project_id TEXT PRIMARY KEY, directory TEXT NOT NULL, completed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id);
      CREATE TABLE IF NOT EXISTS opcode_sessions_deleted (id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS opcode_sessions_message_revision (id TEXT PRIMARY KEY, revision REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS opcode_sessions_message_keys (
        session_id TEXT NOT NULL, source_id TEXT NOT NULL, index_id TEXT NOT NULL UNIQUE, PRIMARY KEY(session_id,source_id)
      );
    `)
    // Additive data migration only, including older text-only indexes. No V1 runtime API.
    const columns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((item) => item.name))
    for (const [name, type] of Object.entries({ provider_id: "TEXT", model_id: "TEXT", cost: "REAL", input_tokens: "INTEGER", output_tokens: "INTEGER", reasoning_tokens: "INTEGER", cache_read_tokens: "INTEGER", cache_write_tokens: "INTEGER" })) {
      if (!columns.has(name)) this.db.run(`ALTER TABLE messages ADD COLUMN ${name} ${type}${type === "TEXT" ? "" : " NOT NULL DEFAULT 0"}`)
    }
  }

  close() { this.db.close() }
  ids(directory?: string) {
    return this.db.query<{ id: string }, [string, string]>("SELECT id FROM sessions WHERE ?='' OR directory=?")
      .all(directory ?? "", directory ?? "").map((row) => row.id)
  }
  deleted(id: string) { return !!this.db.query("SELECT 1 FROM opcode_sessions_deleted WHERE id=?").get(id) }

  remove(id: string) {
    this.db.transaction(() => {
      const family = this.db.query<{ id: string }, [string]>(`WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT s.id FROM sessions s JOIN family f ON s.parent_id=f.id) SELECT id FROM family`).all(id)
      for (const member of family) {
        this.db.query("INSERT OR IGNORE INTO opcode_sessions_deleted VALUES (?,?)").run(member.id, Date.now())
        this.db.query("DELETE FROM opcode_sessions_message_revision WHERE id IN (SELECT id FROM messages WHERE session_id=?)").run(member.id)
        this.db.query("DELETE FROM messages WHERE session_id=?").run(member.id)
        this.db.query("DELETE FROM opcode_sessions_message_keys WHERE session_id=?").run(member.id)
        this.db.query("DELETE FROM sessions WHERE id=?").run(member.id)
      }
    })()
  }

  write(session: SessionRecord, messages: MessageRecord[]) {
    return this.db.transaction(() => {
      if (this.deleted(session.id) || (session.parentID && this.deleted(session.parentID))) return false
      const current = this.db.query<{ updated_at: number }, [string]>("SELECT updated_at FROM sessions WHERE id=?").get(session.id)
      if (current && current.updated_at > session.updatedAt) return false
      this.db.query(`INSERT INTO sessions (id,project_id,directory,title,parent_id,created_at,updated_at,indexed_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        project_id=excluded.project_id,directory=excluded.directory,title=excluded.title,parent_id=excluded.parent_id,
        created_at=excluded.created_at,updated_at=excluded.updated_at,indexed_at=excluded.indexed_at
        WHERE excluded.updated_at >= sessions.updated_at`).run(session.id, session.projectID, session.directory, session.title, session.parentID ?? null, session.createdAt, session.updatedAt, Date.now())
      for (const message of messages) {
        let indexedID = this.db.query<{ index_id: string }, [string, string]>("SELECT index_id FROM opcode_sessions_message_keys WHERE session_id=? AND source_id=?").get(session.id, message.id)?.index_id
        if (!indexedID) {
          const owner = this.db.query<{ session_id: string }, [string]>("SELECT session_id FROM messages WHERE id=?").get(message.id)
          // Forked projections may share source IDs. Preserve the legacy primary key without stealing rows.
          indexedID = owner && owner.session_id !== session.id ? `opcode-sessions/${crypto.randomUUID()}` : message.id
          this.db.query("INSERT INTO opcode_sessions_message_keys VALUES (?,?,?)").run(session.id, message.id, indexedID)
        }
        const revision = this.db.query<{ revision: number }, [string]>("SELECT revision FROM opcode_sessions_message_revision WHERE id=?").get(indexedID)
        if (revision && revision.revision > session.updatedAt) continue
        this.db.query(`INSERT INTO messages (id,session_id,role,created_at,text,provider_id,model_id,cost,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET role=excluded.role,created_at=excluded.created_at,text=excluded.text,
          provider_id=excluded.provider_id,model_id=excluded.model_id,cost=excluded.cost,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
          reasoning_tokens=excluded.reasoning_tokens,cache_read_tokens=excluded.cache_read_tokens,cache_write_tokens=excluded.cache_write_tokens`).run(
          indexedID, session.id, message.role, message.createdAt, message.text, message.providerID ?? null, message.modelID ?? null,
          message.cost, message.input, message.output, message.reasoning, message.cacheRead, message.cacheWrite,
        )
        this.db.query("INSERT INTO opcode_sessions_message_revision VALUES (?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision").run(indexedID, session.updatedAt)
      }
      return true
    })()
  }

  projects(): ProjectOption[] {
    return this.db.query<{ id: string; directory: string }, []>("SELECT project_id AS id, MIN(directory) AS directory FROM sessions GROUP BY project_id ORDER BY MAX(updated_at) DESC, project_id").all()
      .map((row) => ({ ...row, label: basename(row.directory) || row.directory }))
  }

  async search(input: SearchInput, signal?: AbortSignal): Promise<SessionResult[]> {
    validateQuery(input.query)
    const limit = Math.min(200, Math.max(1, input.limit ?? 100))
    // Visibility is applied before matching and limiting, not after the first 100 children.
    const rows = this.db.query<StoredSession, { project: string; children: number }>(`SELECT id,project_id AS projectID,directory,title,parent_id AS parentID,created_at AS createdAt,updated_at AS updatedAt
      FROM sessions WHERE ($project='' OR project_id=$project) AND ($children=1 OR parent_id IS NULL) ORDER BY updated_at DESC,id ASC`)
      .all({ project: input.projectID ?? "", children: input.showSubagents ? 1 : 0 })
    const results: SessionResult[] = []
    const matcher = new RegexMatcher()
    const deadline = Date.now() + 3_000
    const unrestricted = input.query.trim() === "" || input.query.trim() === ".*"
    try {
      for (let start = 0; start < rows.length && results.length < limit; start += 16) {
        signal?.throwIfAborted()
        if (Date.now() > deadline) throw new Error("Search exceeded its scan budget. Filter by project or simplify the query.")
        const batch = rows.slice(start, start + 16)
        const candidates = batch.map((row) => ({ ...row, messages: this.db.query<{ text: string }, [string]>(`SELECT text FROM messages WHERE session_id=? ORDER BY created_at DESC,id DESC${unrestricted ? " LIMIT 1" : ""}`).all(row.id).map((message) => message.text) }))
        const matches = unrestricted
          ? candidates.slice(0, limit - results.length).map((row) => ({ id: row.id, snippet: (row.messages[0] ?? "").slice(0, 4096) }))
          : await matcher.match(input.query, candidates, limit - results.length, signal)
        for (const match of matches) {
          const row = batch.find((item) => item.id === match.id)!
          const metrics = this.db.query<Omit<SessionResult, keyof SessionRecord | "snippet" | "providerID" | "modelID">, [string]>(`SELECT COUNT(*) AS messageCount,
            COUNT(DISTINCT provider_id || '/' || model_id) AS modelCount,COALESCE(SUM(cost),0) AS cost,
            COALESCE(SUM(input_tokens),0) AS input,COALESCE(SUM(output_tokens),0) AS output,COALESCE(SUM(reasoning_tokens),0) AS reasoning,
            COALESCE(SUM(cache_read_tokens),0) AS cacheRead,COALESCE(SUM(cache_write_tokens),0) AS cacheWrite
            FROM messages WHERE session_id=?`).get(row.id)!
          const model = this.db.query<{ providerID: string | null; modelID: string | null }, [string]>("SELECT provider_id AS providerID,model_id AS modelID FROM messages WHERE session_id=? AND model_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1").get(row.id)
          const { parentID, ...session } = row
          // The RPC host validates before JSON encoding: absent optional keys must be omitted,
          // not present with SQL null or JS undefined (both fail the strict string schema).
          results.push({
            ...session, ...metrics, snippet: match.snippet,
            ...(parentID != null ? { parentID } : {}),
            ...(model?.providerID != null ? { providerID: model.providerID } : {}),
            ...(model?.modelID != null ? { modelID: model.modelID } : {}),
          })
        }
      }
      return results
    } finally { matcher.close() }
  }
}

// All location instances in this server process share one writer and queue.
const indexes = new Map<string, { index: SessionIndex; serial: ReturnType<typeof createSerialQueue>; users: number }>()
export function acquireIndex(path: string) {
  const key = path === ":memory:" ? path : resolve(path)
  let entry = indexes.get(key)
  if (!entry) { entry = { index: new SessionIndex(path), serial: createSerialQueue(), users: 0 }; indexes.set(key, entry) }
  entry.users++
  let released = false
  return { index: entry.index, serial: entry.serial, release() {
    if (released) return
    released = true
    if (--entry.users === 0) { entry.index.close(); indexes.delete(key) }
  } }
}
