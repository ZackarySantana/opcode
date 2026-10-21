import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { messageText, sameItem, type LaterItem, type LaterSnapshot } from "./domain"

/** Intentionally retain opencode-later's location and SQL schema. */
export function stateDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "opencode")
}

export function databasePath(state: string, option?: unknown): string {
  if (typeof option !== "string" || !option.trim()) return join(state, "opencode-later", "later.sqlite")
  const path = option.trim()
  return path === ":memory:" || isAbsolute(path) ? path : resolve(state, path)
}

type Row = Omit<LaterItem, "completedAt"> & { completedAt: number | null }
const columns = "id, message, position, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt"
const decode = (row: Row): LaterItem => ({ ...row, completedAt: row.completedAt ?? undefined })

export class LaterDatabase {
  private readonly db: Database
  private closed = false

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true, readwrite: true, strict: true })
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;")
      this.db.exec(`
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
      `)
    } catch (error) {
      this.db.close()
      throw error
    }
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
      const update = this.db.query("UPDATE items SET position = ?, updated_at = ? WHERE id = ?")
      update.run(neighbor.position, now, item.id)
      update.run(item.position, now, neighbor.id)
      return true
    })
  }

  private active(): LaterItem[] {
    return this.db.query<Row, []>(`SELECT ${columns} FROM items WHERE completed_at IS NULL ORDER BY position, created_at, id`).all().map(decode)
  }

  private appendPosition(): number {
    return this.db.query<{ position: number }, []>("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM items WHERE completed_at IS NULL").get()!.position
  }

  private compact(): void {
    const update = this.db.query("UPDATE items SET position = ? WHERE id = ?")
    for (const [index, item] of this.active().entries()) update.run(index + 1, item.id)
  }

  private write(operation: () => boolean): boolean {
    return this.db.transaction(() => {
      const changed = operation()
      if (changed) this.db.exec("UPDATE metadata SET revision = revision + 1 WHERE id = 1")
      return changed
    }).immediate()
  }
}
