import type { Database } from "bun:sqlite"
import { basename, join } from "node:path"
import { openDatabase, resolveStatePath, stateDirectory } from "@opcode/core/state"
import {
  localDay, rangeStart, type Activity, type ActivityKind, type Breakdown, type Dashboard, type DateRange, type TimeDashboard,
  type TimedSession, type Totals, type UsageRecord,
} from "./domain.js"
import { deriveTurns, summarizeTime, type TimelineEvent, type TimedTurn } from "./time.js"

// Deliberately retain opencode-cost's path, including after the package rename.
export function databasePath(configured?: unknown, state = stateDirectory()) {
  return resolveStatePath(configured, join("opencode-cost", "cost.sqlite"), state)
}

const schema = `
  CREATE TABLE IF NOT EXISTS usage (
    message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
    directory TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, variant TEXT,
    created_at INTEGER NOT NULL, completed_at INTEGER, cost REAL NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_created_at ON usage(created_at);
  CREATE TABLE IF NOT EXISTS backfill (project_id TEXT PRIMARY KEY, directory TEXT NOT NULL, completed_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS opcode_cost_live (message_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS session (
    session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity (
    session_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (session_id, at, kind)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
  CREATE INDEX IF NOT EXISTS usage_session ON usage(session_id, created_at);
`

const insert = `INSERT INTO usage (
  message_id, session_id, project_id, directory, provider_id, model_id, variant, created_at, completed_at,
  cost, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, recorded_at
) VALUES ($messageID, $sessionID, $projectID, $directory, $providerID, $modelID, $variant, $createdAt, $completedAt,
  $cost, $input, $output, $reasoning, $cacheRead, $cacheWrite, $recordedAt)`
const identity = `session_id=excluded.session_id, project_id=excluded.project_id, directory=excluded.directory,
  provider_id=excluded.provider_id, model_id=excluded.model_id, variant=excluded.variant, created_at=excluded.created_at,
  completed_at=excluded.completed_at, recorded_at=excluded.recorded_at`
const usage = `cost=excluded.cost, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
  reasoning_tokens=excluded.reasoning_tokens, cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens`
const historical = `WHERE NOT EXISTS (SELECT 1 FROM opcode_cost_live WHERE message_id = excluded.message_id)
  AND excluded.completed_at IS NOT NULL AND (usage.completed_at IS NULL OR usage.completed_at < excluded.completed_at)`
const sums = `COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS messages,
  COALESCE(SUM(input_tokens + output_tokens + reasoning_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens`
/** `provider/model (variant)`, the same for usage and turns, so their breakdowns join by model. */
const model = "provider_id || '/' || model_id || COALESCE(' (' || NULLIF(variant, '') || ')', '')"

type Since = { since: number }
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
      ...record, variant: record.variant ?? null, completedAt: record.completedAt ?? null, recordedAt: Date.now(),
    })
  }

  /**
   * Live collection and history import write identical markers (history stores each marker's event time),
   * so the key makes repeats idempotent without relying on message IDs.
   */
  recordActivity(session: TimedSession, activity: Activity[]) {
    this.db.transaction(() => {
      this.db.query(`INSERT INTO session VALUES ($sessionID, $projectID, $directory, $title, $createdAt) ON CONFLICT(session_id)
        DO UPDATE SET project_id=excluded.project_id, directory=excluded.directory, title=excluded.title`)
        .run({ ...session, title: session.title ?? null })
      const insert = this.db.query("INSERT OR IGNORE INTO activity VALUES (?, ?, ?)")
      for (const item of activity) insert.run(session.sessionID, item.at, item.kind)
    }).immediate()
  }

  lastImport(projectID: string) {
    return this.db.query<{ completedAt: number }, [string]>("SELECT completed_at AS completedAt FROM backfill WHERE project_id = ?").get(projectID)?.completedAt ?? null
  }

  markImported(projectID: string, directory: string) {
    this.db.query(`INSERT INTO backfill VALUES (?, ?, ?) ON CONFLICT(project_id)
      DO UPDATE SET directory=excluded.directory, completed_at=excluded.completed_at`).run(projectID, directory, Date.now())
  }

  dashboard(range: DateRange, now = Date.now()): Dashboard {
    const params: Since = { since: rangeStart(range, now) }
    const total = this.db.query<Totals, Since>(`SELECT ${sums}, COALESCE(SUM(input_tokens), 0) AS input,
      COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheRead, COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite
      FROM usage WHERE created_at >= $since`).get(params)!
    const labels = this.projectLabels(params.since)
    const group = (key: string) => this.db.query<Sums & { id: string }, Since>(`SELECT ${key} AS id, ${sums}
      FROM usage WHERE created_at >= $since GROUP BY 1`).all(params)
    // Tokens break ties, so a view with no cost (subscriptions) ranks its biggest users first.
    const ranked = (rows: Breakdown[]) => rows.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.label.localeCompare(b.label))
    return {
      total,
      projects: ranked(group("project_id").map((row) => ({ ...row, label: labels.get(row.id) ?? row.id }))),
      models: ranked(group(model).map((row) => ({ ...row, label: row.id }))),
      daily: this.daily(params),
    }
  }

  /** Turns of root sessions active since the range start. Whole session timelines are read, so a turn's state is known at the boundary. */
  time(range: DateRange, now = Date.now()): TimeDashboard {
    const since = rangeStart(range, now)
    const params: Since = { since }
    const timed = `timed AS (SELECT * FROM session WHERE session_id IN (
      SELECT session_id FROM activity WHERE at >= $since UNION SELECT session_id FROM usage WHERE created_at >= $since))`
    const sessions = this.db.query<{ sessionID: string; projectID: string; directory: string; title: string | null }, typeof params>(`WITH ${timed}
      SELECT session_id AS sessionID, project_id AS projectID, directory, title FROM timed`).all(params)
    type Row = { sessionID: string; kind: ActivityKind | "step"; at: number; end: number | null; model: string | null; output: number }
    // Ties put idle first: a prompt delivered as the session goes idle starts the next turn. Fork-inherited history predates the fork.
    const rows = this.db.query<Row, typeof params>(`WITH ${timed}
      SELECT session_id AS sessionID, kind, at, NULL AS end, NULL AS model, 0 AS output, kind = 'prompt' AS rank
        FROM activity JOIN timed USING (session_id) WHERE at >= timed.created_at
      UNION ALL SELECT session_id, 'step', usage.created_at, completed_at, ${model}, output_tokens + reasoning_tokens, 2
        FROM usage JOIN timed USING (session_id) WHERE usage.created_at >= timed.created_at
      ORDER BY sessionID, at, rank`).all(params)
    const timelines = new Map<string, TimelineEvent[]>()
    for (const row of rows) {
      const events = timelines.get(row.sessionID) ?? []
      events.push(row.kind === "step"
        ? { kind: "step", at: row.at, end: Math.max(row.at, row.end ?? row.at), model: row.model!, output: row.output }
        : { kind: row.kind, at: row.at })
      timelines.set(row.sessionID, events)
    }
    const labels = this.projectLabels(since)
    const turns: TimedTurn[] = []
    for (const session of sessions) {
      for (const turn of deriveTurns(session.sessionID, timelines.get(session.sessionID) ?? [])) {
        if (turn.start < since) continue
        turns.push({
          ...turn, title: session.title ?? undefined, projectID: session.projectID, directory: session.directory,
          project: labels.get(session.projectID) ?? (basename(session.directory) || session.directory),
        })
      }
    }
    return summarizeTime(turns)
  }

  /** SQLite takes a bare column from the MAX() row: the latest-used directory labels a project. */
  private projectLabels(since: number) {
    return new Map(this.db.query<{ id: string; directory: string }, [number]>(`SELECT project_id AS id, directory, MAX(created_at)
      FROM usage WHERE created_at >= ? GROUP BY project_id`).all(since).map(({ id, directory }) => [id, basename(directory) || directory]))
  }

  /**
   * Local dates with usage, newest first. Day boundaries come from the same JS local calendar as
   * rangeStart (DST-aware), rather than SQLite/libc's potentially different timezone.
   */
  private daily(params: Since) {
    const latest = this.db.query<{ at: number | null }, Since & { before: number }>(`SELECT MAX(created_at) AS at FROM usage
      WHERE created_at >= $since AND created_at < $before`)
    const day = this.db.query<Sums, { start: number; end: number }>(`SELECT ${sums} FROM usage
      WHERE created_at >= $start AND created_at < $end`)
    const days: Breakdown[] = []
    let before = Number.MAX_SAFE_INTEGER
    for (;;) {
      const at = latest.get({ ...params, before })?.at
      if (at === null || at === undefined) break
      const date = new Date(at)
      date.setHours(0, 0, 0, 0)
      const start = date.getTime()
      const id = localDay(start)
      date.setDate(date.getDate() + 1)
      days.push({ id, label: id, ...day.get({ start, end: date.getTime() })! })
      before = start
    }
    return days
  }
}
