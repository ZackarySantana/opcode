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
const sums = `COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS messages,
  COALESCE(SUM(input_tokens + output_tokens + reasoning_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens`
const filtered = "created_at >= $since AND ($projectID IS NULL OR project_id = $projectID) AND ($model IS NULL OR provider_id || '/' || model_id = $model)"

type Filter = { since: number; projectID: string | null; model: string | null }
type Sums = Pick<Breakdown, "cost" | "messages" | "tokens">

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
    const params: Filter = { since, projectID: filter.projectID ?? null, model: filter.model ?? null }
    const total = this.db.query<Totals, Filter>(`SELECT ${sums}, COALESCE(SUM(input_tokens), 0) AS input,
      COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheRead, COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite
      FROM usage WHERE ${filtered}`).get(params)!
    // Options ignore entity filters. SQLite takes a bare column from the MAX() row: the latest-used directory labels a project.
    const projectOptions = this.db.query<{ id: string; directory: string }, [number]>(`SELECT project_id AS id, directory, MAX(created_at)
      FROM usage WHERE created_at >= ? GROUP BY project_id`).all(since)
      .map(({ id, directory }) => ({ id, label: basename(directory) || directory, directory }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    const labels = new Map(projectOptions.map((option) => [option.id, option.label]))
    const group = (key: string) => this.db.query<Sums & { id: string }, Filter>(`SELECT ${key} AS id, ${sums}
      FROM usage WHERE ${filtered} GROUP BY 1`).all(params)
    const ranked = (rows: Breakdown[]) => rows.sort((a, b) => b.cost - a.cost || a.label.localeCompare(b.label)).slice(0, 8)
    return {
      total,
      projects: ranked(group("project_id").map((row) => ({ ...row, label: labels.get(row.id) ?? row.id }))),
      models: ranked(group("provider_id || '/' || model_id").map((row) => ({ ...row, label: row.id }))),
      daily: this.daily(params),
      projectOptions,
      modelOptions: this.db.query<{ id: string }, [number]>("SELECT DISTINCT provider_id || '/' || model_id AS id FROM usage WHERE created_at >= ?")
        .all(since).map(({ id }) => id).sort().map((id) => ({ id, label: id })),
    }
  }

  /**
   * The newest 14 local dates with usage. Day boundaries come from the same JS local calendar as
   * rangeStart (DST-aware), rather than SQLite/libc's potentially different timezone.
   */
  private daily(params: Filter) {
    const latest = this.db.query<{ at: number | null }, Filter & { before: number }>(`SELECT MAX(created_at) AS at FROM usage
      WHERE ${filtered} AND created_at < $before`)
    const day = this.db.query<Sums, Filter & { start: number; end: number }>(`SELECT ${sums} FROM usage
      WHERE ${filtered} AND created_at >= $start AND created_at < $end`)
    const days: Breakdown[] = []
    let before = Number.MAX_SAFE_INTEGER
    while (days.length < 14) {
      const at = latest.get({ ...params, before })?.at
      if (at === null || at === undefined) break
      const date = new Date(at)
      date.setHours(0, 0, 0, 0)
      const start = date.getTime()
      const id = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      date.setDate(date.getDate() + 1)
      days.push({ id, label: id, ...day.get({ ...params, start, end: date.getTime() })! })
      before = start
    }
    return days
  }
}
