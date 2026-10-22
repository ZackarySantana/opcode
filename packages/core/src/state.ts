import { Database } from "bun:sqlite"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export function stateDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "opencode")
}

/** A configured path is used verbatim when absolute or ":memory:", otherwise relative to state, not cwd. */
export function resolveStatePath(configured: unknown, fallback: string, state = stateDirectory()): string {
  if (typeof configured !== "string" || !configured.trim()) return join(state, fallback)
  const path = configured.trim()
  return path === ":memory:" || isAbsolute(path) ? path : resolve(state, path)
}

/** Open a WAL database, creating new files owner-only before SQLite can write to them.
 * Existing files keep their permissions. The handle is closed when setup fails. */
export function openDatabase(path: string, setup: (db: Database) => void): Database {
  const fresh = path !== ":memory:" && !existsSync(path)
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (fresh) {
    closeSync(openSync(path, "a", 0o600))
    chmodSync(path, 0o600)
  }
  const db = new Database(path, { create: true, strict: true })
  try {
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA journal_mode = WAL")
    setup(db)
  } catch (error) {
    db.close()
    throw error
  }
  if (fresh) for (const sidecar of [`${path}-wal`, `${path}-shm`]) if (existsSync(sidecar)) chmodSync(sidecar, 0o600)
  return db
}
