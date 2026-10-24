import type { Database } from "bun:sqlite"
import { join } from "node:path"
import { openDatabase, resolveStatePath, stateDirectory } from "@opcode/core/state"
import { defaultSettings, messageText, sameItem, sidebarItemChoices, type LaterItem, type LaterSnapshot, type Settings } from "./domain"

/** Intentionally retain opencode-later's location and SQL schema. */
export function databasePath(option?: unknown, state = stateDirectory()): string {
  return resolveStatePath(option, join("opencode-later", "later.sqlite"), state)
}

type Row = Omit<LaterItem, "completedAt"> & { completedAt: number | null }
const columns = "id, message, position, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt"
const decode = (row: Row): LaterItem => ({ ...row, completedAt: row.completedAt ?? undefined })

export class LaterDatabase {
  private readonly db: Database
  private closed = false

  constructor(path: string) {
    this.db = openDatabase(path, (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS items_active_position ON items(completed_at, position);
      CREATE TABLE IF NOT EXISTS metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO metadata (id, revision) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sidebar_items INTEGER NOT NULL
      );
    `))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  revision(): number {
    return this.db.query<{ revision: number }, []>("SELECT revision FROM metadata WHERE id = 1").get()!.revision
  }

  /** Read revision, active order, and history from one consistent SQLite snapshot. */
  snapshot(): LaterSnapshot {
    return this.db.transaction(() => ({
      revision: this.revision(),
      active: this.active(),
      completed: this.db.query<Row, []>(`SELECT ${columns} FROM items WHERE completed_at IS NOT NULL ORDER BY completed_at DESC, id`).all().map(decode),
    }))()
  }

  get(id: string): LaterItem | undefined {
    const row = this.db.query<Row, [string]>(`SELECT ${columns} FROM items WHERE id = ?`).get(id)
    return row ? decode(row) : undefined
  }

  add(text: string, now = Date.now()): string {
    const message = messageText(text)
    const id = crypto.randomUUID()
    this.write(() => {
      this.db.query("INSERT INTO items (id, message, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, message, this.appendPosition(), now, now)
      return true
    })
    return id
  }

  edit(item: LaterItem, text: string, now = Date.now()): boolean {
    const message = messageText(text)
    return this.write(() => {
      if (!sameItem(this.get(item.id), item)) return false
      this.db.query("UPDATE items SET message = ?, updated_at = ? WHERE id = ?").run(message, now, item.id)
      return true
    })
  }

  complete(item: LaterItem, now = Date.now()): boolean {
    return this.write(() => {
      if (item.completedAt !== undefined || !sameItem(this.get(item.id), item)) return false
      this.db.query("UPDATE items SET completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, item.id)
      this.compact()
      return true
    })
  }

  restore(item: LaterItem, now = Date.now()): boolean {
    return this.write(() => {
      if (item.completedAt === undefined || !sameItem(this.get(item.id), item)) return false
      this.db.query("UPDATE items SET completed_at = NULL, position = ?, updated_at = ? WHERE id = ?")
        .run(this.appendPosition(), now, item.id)
      return true
    })
  }

  delete(item: LaterItem): boolean {
    return this.write(() => {
      if (!sameItem(this.get(item.id), item)) return false
      this.db.query("DELETE FROM items WHERE id = ?").run(item.id)
      this.compact()
      return true
    })
  }

  move(item: LaterItem, offset: -1 | 1, now = Date.now()): boolean {
    return this.write(() => {
      if (!sameItem(this.get(item.id), item)) return false
      const active = this.active()
      const index = active.findIndex((entry) => entry.id === item.id)
      const neighbor = index < 0 ? undefined : active[index + offset]
      if (!neighbor) return false
      active[index + offset] = active[index]!
      active[index] = neighbor
      this.db.query("UPDATE items SET updated_at = ? WHERE id IN (?, ?)").run(now, item.id, neighbor.id)
      // Rewrite every position: legacy lists may contain duplicates that a swap would not reorder.
      this.renumber(active)
      return true
    })
  }

  settings(): Settings {
    const row = this.db.query<{ sidebarItems: number }, []>("SELECT sidebar_items AS sidebarItems FROM settings WHERE id = 1").get()
    return row && sidebarItemChoices.includes(row.sidebarItems) ? { sidebarItems: row.sidebarItems } : defaultSettings
  }

  saveSettings(settings: Settings): void {
    this.db.query("INSERT INTO settings (id, sidebar_items) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET sidebar_items = excluded.sidebar_items")
      .run(settings.sidebarItems)
  }

  private active(): LaterItem[] {
    return this.db.query<Row, []>(`SELECT ${columns} FROM items WHERE completed_at IS NULL ORDER BY position, created_at, id`).all().map(decode)
  }

  private appendPosition(): number {
    return this.db.query<{ position: number }, []>("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM items WHERE completed_at IS NULL").get()!.position
  }

  private compact(): void {
    this.renumber(this.active())
  }

  private renumber(active: readonly LaterItem[]): void {
    const update = this.db.query("UPDATE items SET position = ? WHERE id = ?")
    for (const [index, item] of active.entries()) update.run(index + 1, item.id)
  }

  private write(operation: () => boolean): boolean {
    return this.db.transaction(() => {
      const changed = operation()
      if (changed) this.db.exec("UPDATE metadata SET revision = revision + 1 WHERE id = 1")
      return changed
    }).immediate()
  }
}
