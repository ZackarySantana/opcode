import type { Database } from "bun:sqlite"
import { basename, join } from "node:path"
import { openDatabase, resolveStatePath, stateDirectory } from "@opcode/core/state"
import { rangeStart, type Breakdown, type Dashboard, type DashboardFilter, type Totals, type UsageRecord } from "./domain.js"

// Deliberately retain opencode-cost's path, including after the package rename.
export function databasePath(configured?: unknown, state = stateDirectory()) {
  return resolveStatePath(configured, join("opencode-cost", "cost.sqlite"), state)
}

const schema = `
  CREATE TABLE IF NOT EXISTS usage (
    message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
    directory TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, completed_at INTEGER, cost REAL NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_created_at ON usage(created_at);
  CREATE INDEX IF NOT EXISTS usage_project_id ON usage(project_id);
  CREATE INDEX IF NOT EXISTS usage_model ON usage(provider_id, model_id);
  CREATE TABLE IF NOT EXISTS backfill (project_id TEXT PRIMARY KEY, directory TEXT NOT NULL, completed_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS opcode_cost_live (message_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
`

const insert = `INSERT INTO usage (
  message_id, session_id, project_id, directory, provider_id, model_id, created_at, completed_at,
  cost, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, recorded_at
) VALUES ($messageID, $sessionID, $projectID, $directory, $providerID, $modelID, $createdAt, $completedAt,
  $cost, $input, $output, $reasoning, $cacheRead, $cacheWrite, $recordedAt)`
const identity = `session_id=excluded.session_id, project_id=excluded.project_id, directory=excluded.directory,
  provider_id=excluded.provider_id, model_id=excluded.model_id, created_at=excluded.created_at,
  completed_at=excluded.completed_at, recorded_at=excluded.recorded_at`
const usage = `cost=excluded.cost, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
  reasoning_tokens=excluded.reasoning_tokens, cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens`
const historical = `WHERE NOT EXISTS (SELECT 1 FROM opcode_cost_live WHERE message_id = excluded.message_id)
  AND excluded.completed_at IS NOT NULL AND (usage.completed_at IS NULL OR usage.completed_at < excluded.completed_at)`

export class CostLedger {
  private readonly db: Database

  constructor(path: string) {
    this.db = openDatabase(path, (db) => db.run(schema))
  }

  close() { this.db.close(false) }

  /** Without `usage`, a new row starts from the record but an existing row keeps its recorded usage. */
  recordLive(record: UsageRecord, version: number, options: { usage?: boolean } = {}) {
    this.db.transaction(() => {
      const prior = this.db.query<{ version: number }, [string]>("SELECT version FROM opcode_cost_live WHERE message_id = ?").get(record.messageID)
      if (prior && prior.version > version) return
      this.write(record, options.usage === false ? identity : `${identity}, ${usage}`)
      this.db.query("INSERT INTO opcode_cost_live VALUES (?, ?) ON CONFLICT(message_id) DO UPDATE SET version=excluded.version").run(record.messageID, version)
    }).immediate()
  }

  importBatch(records: UsageRecord[]) {
    this.db.transaction(() => {
      for (const record of records) {
        // Fork histories inherit global message IDs. Keep one billed row and its existing
        // attribution: session authorization alone cannot establish a different source message.
        const existing = this.db.query<{ sessionID: string }, [string]>(
          "SELECT session_id AS sessionID FROM usage WHERE message_id = ?",
        ).get(record.messageID)
        if (existing && existing.sessionID !== record.sessionID) continue
        this.write(record, `${identity}, ${usage} ${historical}`)
        // Update mutable attribution even when freshness/live precedence rejects historical usage values.
        this.db.query("UPDATE usage SET project_id = ?, directory = ? WHERE message_id = ? AND session_id = ?")
          .run(record.projectID, record.directory, record.messageID, record.sessionID)
      }
    }).immediate()
  }

  private write(record: UsageRecord, update: string) {
    this.db.query(`${insert} ON CONFLICT(message_id) DO UPDATE SET ${update}`).run({
      ...record, completedAt: record.completedAt ?? null, recordedAt: Date.now(),
    })
  }

  lastImport(projectID: string) {
    return this.db.query<{ completedAt: number }, [string]>("SELECT completed_at AS completedAt FROM backfill WHERE project_id = ?").get(projectID)?.completedAt ?? null
  }

  markImported(projectID: string, directory: string) {
    this.db.query(`INSERT INTO backfill VALUES (?, ?, ?) ON CONFLICT(project_id)
      DO UPDATE SET directory=excluded.directory, completed_at=excluded.completed_at`).run(projectID, directory, Date.now())
  }

  dashboard(filter: DashboardFilter, now = Date.now()): Dashboard {
    const since = rangeStart(filter.range, now)
    const total: Totals = { cost: 0, messages: 0, tokens: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const projects = new Map<string, Breakdown>()
    const models = new Map<string, Breakdown>()
    const days = new Map<string, Breakdown>()
    const directories = new Map<string, string>()
    const modelIDs = new Set<string>()
    // Stream one indexed date-range query. No per-group arrays or copied message history.
    const rows = this.db.query<Omit<UsageRecord, "messageID" | "sessionID" | "completedAt">, [number]>(`SELECT project_id AS projectID, directory, provider_id AS providerID,
      model_id AS modelID, created_at AS createdAt, cost, input_tokens AS input, output_tokens AS output,
      reasoning_tokens AS reasoning, cache_read_tokens AS cacheRead, cache_write_tokens AS cacheWrite
      FROM usage WHERE created_at >= ?`).iterate(since)
    for (const row of rows) {
      const model = `${row.providerID}/${row.modelID}`
      const prior = directories.get(row.projectID)
      if (!prior || row.directory < prior) directories.set(row.projectID, row.directory)
      modelIDs.add(model)
      if (filter.projectID && row.projectID !== filter.projectID) continue
      if (filter.model && model !== filter.model) continue
      const count = row.input + row.output + row.reasoning + row.cacheRead + row.cacheWrite
      total.cost += row.cost
      total.messages++
      total.tokens += count
      for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) total[key] += row[key]
      addGroup(projects, row.projectID, row.cost, count)
      addGroup(models, model, row.cost, count)
      // Use the same JS local calendar as rangeStart, rather than SQLite/libc's potentially different timezone.
      const date = new Date(row.createdAt)
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      addGroup(days, day, row.cost, count)
    }
    const projectOptions = [...directories].map(([id, directory]) => ({ id, label: basename(directory) || directory, directory }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    for (const option of projectOptions) {
      const group = projects.get(option.id)
      if (group) group.label = option.label
    }
    const ranked = (groups: Map<string, Breakdown>) => [...groups.values()].sort((a, b) => b.cost - a.cost || a.label.localeCompare(b.label)).slice(0, 8)
    return {
      total, projects: ranked(projects), models: ranked(models),
      daily: [...days.values()].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 14),
      projectOptions, modelOptions: [...modelIDs].sort().map((id) => ({ id, label: id })),
    }
  }
}

function addGroup(groups: Map<string, Breakdown>, id: string, cost: number, tokens: number) {
  let group = groups.get(id)
  if (!group) { group = { id, label: id, cost: 0, messages: 0, tokens: 0 }; groups.set(id, group) }
  group.cost += cost
  group.messages++
  group.tokens += tokens
}
