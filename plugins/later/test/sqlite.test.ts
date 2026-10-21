import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { databasePath, LaterDatabase, stateDirectory } from "../src/sqlite"

const cleanup: Array<() => void> = []
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop() })

function memory() {
  const database = new LaterDatabase(":memory:")
  cleanup.push(() => database.close())
  return database
}

function disk() {
  const directory = mkdtempSync(join(tmpdir(), "opcode-later-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "nested", "later.sqlite")
  const first = new LaterDatabase(path)
  const second = new LaterDatabase(path)
  cleanup.push(() => first.close(), () => second.close())
  return { path, first, second }
}

test("trims text, allows duplicates, and preserves internal multiline Unicode", () => {
  const database = memory()
  const first = database.add("  café ☕\nadd tests  ", 1)
  const second = database.add("café ☕\nadd tests", 2)
  expect(first).not.toBe(second)
  expect(database.snapshot().active.map((item) => [item.message, item.position, item.createdAt, item.updatedAt]))
    .toEqual([["café ☕\nadd tests", 1, 1, 1], ["café ☕\nadd tests", 2, 2, 2]])
})

test("completion compacts active order, history is newest first, and restoration appends", () => {
  const database = memory()
  const first = database.add("first", 1)
  const second = database.add("second", 2)
  const third = database.add("third", 3)
  expect(database.complete(database.get(second)!, 10)).toBe(true)
  expect(database.snapshot().active.map((item) => [item.message, item.position])).toEqual([["first", 1], ["third", 2]])
  expect(database.complete(database.get(first)!, 11)).toBe(true)
  expect(database.snapshot().completed.map((item) => item.message)).toEqual(["first", "second"])
  expect(database.restore(database.get(second)!, 12)).toBe(true)
  expect(database.snapshot().active.map((item) => [item.message, item.position])).toEqual([["third", 1], ["second", 2]])
  expect(database.get(second)).toMatchObject({ id: second, createdAt: 2, updatedAt: 12, completedAt: undefined })
  expect(database.get(third)?.updatedAt).toBe(3)
})

test("adjacent reordering, completed editing, and permanent deletion retain their distinct semantics", () => {
  const database = memory()
  const first = database.add("first", 1)
  const second = database.add("second", 2)
  expect(database.move(database.get(second)!, -1, 4)).toBe(true)
  expect(database.snapshot().active.map((item) => item.id)).toEqual([second, first])
  database.complete(database.get(second)!, 0)
  expect(database.edit(database.get(second)!, "edited history", 5)).toBe(true)
  expect(database.get(second)).toMatchObject({ message: "edited history", completedAt: 0, createdAt: 2, updatedAt: 5 })
  expect(database.delete(database.get(second)!)).toBe(true)
  expect(database.snapshot().completed).toEqual([])
  expect(database.delete(database.get(first)!)).toBe(true)
  expect(database.snapshot().active).toEqual([])
})

test("invalid input and no-op mutations do not advance revisions", () => {
  const database = memory()
  expect(() => database.add(" \n\t")).toThrow("Message cannot be empty")
  expect(database.revision()).toBe(0)
  const id = database.add("one", 1)
  const item = database.get(id)!
  expect(() => database.edit(item, "   ")).toThrow("Message cannot be empty")
  expect(database.move(item, -1)).toBe(false)
  expect(database.move(item, 1)).toBe(false)
  expect(database.restore(item)).toBe(false)
  expect(database.revision()).toBe(1)
  database.complete(item, 2)
  const completed = database.get(id)!
  expect(database.complete(completed)).toBe(false)
  expect(database.move(completed, 1)).toBe(false)
  expect(database.revision()).toBe(2)
  database.delete(completed)
  expect(database.delete(completed)).toBe(false)
  expect(database.revision()).toBe(3)
})

test("cross-connection updates persist across closing and reopening", () => {
  const { path, first, second } = disk()
  const firstID = first.add("one", 1)
  const secondID = second.add("two", 2)
  first.move(first.get(secondID)!, -1, 3)
  second.complete(second.get(firstID)!, 4)
  expect(second.snapshot()).toEqual(first.snapshot())
  expect(first.snapshot().revision).toBe(4)
  first.close()
  second.close()
  const reopened = new LaterDatabase(path)
  cleanup.push(() => reopened.close())
  expect(reopened.snapshot()).toMatchObject({
    revision: 4,
    active: [{ id: secondID, message: "two", position: 1 }],
    completed: [{ id: firstID, message: "one", completedAt: 4 }],
  })
})

test("stale edits, deletions, and completions cannot overwrite another connection", () => {
  const { first, second } = disk()
  const id = first.add("original", 1)
  const stale = first.get(id)!
  second.edit(second.get(id)!, "newer", 2)
  expect(first.edit(stale, "lost update", 3)).toBe(false)
  expect(first.delete(stale)).toBe(false)
  expect(first.complete(stale)).toBe(false)
  expect(second.get(id)?.message).toBe("newer")
  expect(first.revision()).toBe(2)
})

test("a failed revision write rolls back the item mutation", () => {
  const { path, first } = disk()
  const raw = new Database(path)
  try {
    raw.exec("CREATE TRIGGER reject_revision BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    expect(() => first.add("must roll back")).toThrow("test failure")
    expect(first.snapshot()).toEqual({ revision: 0, active: [], completed: [] })
  } finally { raw.close() }
})

test("opens an existing legacy schema without losing IDs, timestamps, order, or history", () => {
  const directory = mkdtempSync(join(tmpdir(), "opcode-later-legacy-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "legacy.sqlite")
  // Create the legacy contract independently, before the new repository opens it.
  const raw = new Database(path, { create: true })
  try {
    raw.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, message TEXT NOT NULL, position INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
      INSERT INTO items VALUES ('legacy-b', 'second', 2, 20, 21, NULL);
      INSERT INTO items VALUES ('legacy-a', 'first', 1, 10, 11, NULL);
      INSERT INTO items VALUES ('legacy-history', 'done', 7, 1, 30, 30);
      INSERT INTO metadata VALUES (1, 42);
    `)
  } finally { raw.close() }
  const database = new LaterDatabase(path)
  cleanup.push(() => database.close())
  expect(database.snapshot()).toEqual({
    revision: 42,
    active: [
      { id: "legacy-a", message: "first", position: 1, createdAt: 10, updatedAt: 11, completedAt: undefined },
      { id: "legacy-b", message: "second", position: 2, createdAt: 20, updatedAt: 21, completedAt: undefined },
    ],
    completed: [{ id: "legacy-history", message: "done", position: 7, createdAt: 1, updatedAt: 30, completedAt: 30 }],
  })
  database.edit(database.get("legacy-a")!, "edited legacy", 100)
  database.move(database.get("legacy-b")!, -1, 101)
  database.complete(database.get("legacy-b")!, 102)
  database.restore(database.get("legacy-history")!, 103)
  database.delete(database.get("legacy-b")!)
  const added = database.add("new item", 104)
  database.close()
  // Do not use the repository's own decoder to verify the on-disk write contract.
  const reopened = new Database(path, { readonly: true })
  try {
    expect(reopened.query("SELECT id, message, position, created_at, updated_at, completed_at FROM items ORDER BY position").all()).toEqual([
      { id: "legacy-a", message: "edited legacy", position: 1, created_at: 10, updated_at: 101, completed_at: null },
      { id: "legacy-history", message: "done", position: 2, created_at: 1, updated_at: 103, completed_at: null },
      { id: added, message: "new item", position: 3, created_at: 104, updated_at: 104, completed_at: null },
    ])
    expect(reopened.query("SELECT revision FROM metadata WHERE id = 1").get()).toEqual({ revision: 48 })
  } finally { reopened.close() }
})

test("keeps the legacy state path and resolves custom paths relative to state, not cwd", () => {
  expect(stateDirectory({}, "/home/example")).toBe("/home/example/.local/state/opencode")
  expect(stateDirectory({ XDG_STATE_HOME: "/custom" })).toBe("/custom/opencode")
  expect(databasePath("/state")).toBe("/state/opencode-later/later.sqlite")
  expect(databasePath("/state", " nested/custom.sqlite ")).toBe("/state/nested/custom.sqlite")
  expect(databasePath("/state", "/absolute/list.sqlite")).toBe("/absolute/list.sqlite")
  expect(databasePath("/state", ":memory:")).toBe(":memory:")
  for (const option of [undefined, null, 12, "  "]) expect(databasePath("/state", option)).toBe("/state/opencode-later/later.sqlite")
})
