import type { Database } from "bun:sqlite"
import { join } from "node:path"
import { openDatabase, resolveStatePath, stateDirectory } from "@opcode/core/state"
import { defaultSettings, scopeChoices, type Settings, type SurfaceScope } from "./model"
import type { FeedKind } from "./presets"

export function databasePath(option?: unknown, state = stateDirectory()): string {
  return resolveStatePath(option, join("opcode-feed", "feed.sqlite"), state)
}

export interface Subscription {
  readonly url: string
  /** The feed's own title, learned on the first successful fetch. */
  readonly title?: string
  readonly kind: FeedKind
  readonly createdAt: number
}

type Row = { url: string; title: string | null; kind: string; createdAt: number }

/** 0.1.0 created settings without `updates`; add it with the default rather than rebuilding the table. */
function migrate(db: Database): void {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(settings)").all().map((column) => column.name)
  if (!columns.includes("updates")) db.exec("ALTER TABLE settings ADD COLUMN updates TEXT NOT NULL DEFAULT 'feed'")
}

/** Client-local subscriptions and settings. Fetched items are not persisted. */
export class FeedsDatabase {
  private readonly db: Database
  private closed = false

  constructor(path: string) {
    this.db = openDatabase(path, (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          url TEXT PRIMARY KEY,
          title TEXT,
          kind TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          window_hours INTEGER NOT NULL,
          resolved TEXT NOT NULL,
          updates TEXT NOT NULL DEFAULT 'feed'
        );
      `)
      migrate(db)
    })
  }

  settings(): Settings {
    const row = this.db.query<{ windowHours: number; resolved: string; updates: string }, []>("SELECT window_hours AS windowHours, resolved, updates FROM settings WHERE id = 1").get()
    if (!row) return defaultSettings
    const scope = (value: string, fallback: SurfaceScope) => scopeChoices.find((choice) => choice === value) ?? fallback
    return { windowHours: row.windowHours, resolved: scope(row.resolved, defaultSettings.resolved), updates: scope(row.updates, defaultSettings.updates) }
  }

  saveSettings(settings: Settings): void {
    this.db.query(`INSERT INTO settings (id, window_hours, resolved, updates) VALUES (1, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET window_hours = excluded.window_hours, resolved = excluded.resolved, updates = excluded.updates`)
      .run(settings.windowHours, settings.resolved, settings.updates)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  list(): Subscription[] {
    return this.db.query<Row, []>("SELECT url, title, kind, created_at AS createdAt FROM subscriptions ORDER BY created_at, url").all()
      .map((row) => ({ url: row.url, title: row.title ?? undefined, kind: row.kind === "updates" ? "updates" : "status", createdAt: row.createdAt }))
  }

  subscribe(url: string, kind: FeedKind, now = Date.now()): boolean {
    return this.db.query("INSERT OR IGNORE INTO subscriptions (url, kind, created_at) VALUES (?, ?, ?)").run(url, kind, now).changes > 0
  }

  unsubscribe(url: string): boolean {
    return this.db.query("DELETE FROM subscriptions WHERE url = ?").run(url).changes > 0
  }

  rename(url: string, title: string): void {
    this.db.query("UPDATE subscriptions SET title = ? WHERE url = ? AND title IS NOT ?").run(title, url, title)
  }
}
