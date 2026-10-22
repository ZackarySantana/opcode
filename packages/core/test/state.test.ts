import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, resolveStatePath, stateDirectory } from "../src/state"

const posix = process.platform !== "win32"
const mode = (path: string) => statSync(path).mode & 0o777
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "opcode-core-state-"))
  directories.push(directory)
  return directory
}

test("state paths follow XDG and resolve configured paths relative to state, not cwd", () => {
  expect(stateDirectory({}, "/home/example")).toBe("/home/example/.local/state/opencode")
  expect(stateDirectory({ XDG_STATE_HOME: "/custom" }, "/home/example")).toBe("/custom/opencode")
  expect(resolveStatePath(undefined, "plugin/db.sqlite", "/state")).toBe("/state/plugin/db.sqlite")
  for (const option of [null, 12, "  "]) expect(resolveStatePath(option, "plugin/db.sqlite", "/state")).toBe("/state/plugin/db.sqlite")
  expect(resolveStatePath(" nested/custom.sqlite ", "plugin/db.sqlite", "/state")).toBe("/state/nested/custom.sqlite")
  expect(resolveStatePath("../outside.sqlite", "plugin/db.sqlite", "/state/opencode")).toBe("/state/outside.sqlite")
  expect(resolveStatePath("/absolute/db.sqlite", "plugin/db.sqlite", "/state")).toBe("/absolute/db.sqlite")
  expect(resolveStatePath(" :memory: ", "plugin/db.sqlite", "/state")).toBe(":memory:")
})

test("new databases and their directories and WAL sidecars are owner-only", () => {
  const directory = join(temporary(), "nested", "private")
  const path = join(directory, "data.sqlite")
  const db = openDatabase(path, (db) => db.run("CREATE TABLE items (id TEXT)"))
  try {
    db.run("INSERT INTO items VALUES ('a')")
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
    if (posix) {
      expect(mode(directory)).toBe(0o700)
      for (const file of [path, `${path}-wal`, `${path}-shm`]) expect(mode(file)).toBe(0o600)
    }
  } finally { db.close() }
})

test("existing database permissions are left to their owner", () => {
  if (!posix) return
  const path = join(temporary(), "shared.sqlite")
  new Database(path, { create: true }).close()
  chmodSync(path, 0o640)
  openDatabase(path, () => {}).close()
  expect(mode(path)).toBe(0o640)
})

test("a failing setup closes the handle and leaves the file reopenable", () => {
  const path = join(temporary(), "broken.sqlite")
  let opened: Database | undefined
  expect(() => openDatabase(path, (db) => { opened = db; db.run("NOT SQL") })).toThrow()
  expect(() => opened!.query("SELECT 1").get()).toThrow()
  const db = openDatabase(path, (db) => db.run("CREATE TABLE ok (id TEXT)"))
  db.close()
  expect(() => openDatabase(":memory:", () => { throw new Error("setup failed") })).toThrow("setup failed")
})
