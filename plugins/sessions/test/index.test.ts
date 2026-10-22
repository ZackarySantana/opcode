import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionIndex, databasePath } from "../src/index-store"
import { messageRecord } from "../src/domain"
import { RegexMatcher } from "../src/regex"
import { assistant, message, record } from "./fixtures"

test("regex searches full text, title and directory; ordering and snippets use recency", async () => {
  const index = new SessionIndex(":memory:")
  try {
    index.write({ ...record("s1"), title: "Authentication" }, [message(), { ...message("m2", "new JWT rotation"), createdAt: 4 }])
    index.write({ ...record("s2", 200), projectID: "p2", directory: "/work/beta", title: "Dashboard" }, [message("other", "charts")])
    expect((await index.search({ query: "", showSubagents: false })).map((row) => row.id)).toEqual(["s2", "s1"])
    expect(await index.search({ query: "jwt.*(rotation|refresh)", showSubagents: false })).toMatchObject([{ id: "s1", snippet: "new JWT rotation" }])
    expect((await index.search({ query: "authentication|beta", showSubagents: false })).map((row) => row.id)).toEqual(["s2", "s1"])
    expect(await index.search({ query: "JWT", projectID: "p2", showSubagents: false })).toEqual([])
    await expect(index.search({ query: "[", showSubagents: false })).rejects.toThrow()
    await expect(index.search({ query: "x".repeat(257), showSubagents: false })).rejects.toThrow("256")
  } finally { index.close() }
})

test("search omits absent SQL identifiers before any JSON serialization", async () => {
  const index = new SessionIndex(":memory:")
  try {
    index.write(record("root", 200), [message("user", "No assistant model")])
    index.write({ ...record("child", 100), parentID: "root" }, [messageRecord(assistant())!])
    const [root, child] = await index.search({ query: "", showSubagents: true })
    for (const key of ["parentID", "providerID", "modelID"] as const) expect(Object.hasOwn(root!, key)).toBe(false)
    expect(child).toMatchObject({ parentID: "root", providerID: "openai", modelID: "test-model" })
  } finally { index.close() }
})

test("hides children before result limit, not after the newest children fill it", async () => {
  const index = new SessionIndex(":memory:")
  try {
    index.write(record("root", 1), [])
    for (let n = 0; n < 120; n++) index.write({ ...record(`child-${n}`, n + 2), parentID: "root" }, [])
    expect(await index.search({ query: "", showSubagents: false, limit: 1 })).toMatchObject([{ id: "root" }])
    expect(await index.search({ query: "", showSubagents: true, limit: 1 })).toMatchObject([{ id: "child-119" }])
  } finally { index.close() }
})

test("matching and project filtering precede the cap even with over 200 newer nonmatches", async () => {
  const index = new SessionIndex(":memory:")
  try {
    index.write(record("old-p1", 1), [message("p1-needle", "historical needle")])
    index.write({ ...record("old-p2", 2), projectID: "p2" }, [message("p2-needle", "historical needle")])
    for (let n = 0; n < 220; n++) index.write(record(`new-${n}`, n + 3), [message(`new-message-${n}`, "unrelated text")])
    expect(await index.search({ query: "historical.*needle", showSubagents: false, limit: 1 })).toMatchObject([{ id: "old-p2" }])
    expect(await index.search({ query: "historical.*needle", projectID: "p1", showSubagents: false, limit: 1 })).toMatchObject([{ id: "old-p1", snippet: "historical needle" }])
  } finally { index.close() }
})

test("upserts metrics once, rejects older snapshots, and tombstones deleted families", async () => {
  const index = new SessionIndex(":memory:")
  try {
    const metrics = messageRecord(assistant())!
    index.write(record(), [metrics]); index.write(record(), [metrics])
    expect(await index.search({ query: "", showSubagents: false })).toMatchObject([{ messageCount: 1, cost: 0.25, modelCount: 1, input: 100 }])
    expect(index.write({ ...record("s1", 99), title: "stale" }, [{ ...metrics, cost: 0 }])).toBe(false)
    index.write({ ...record("child"), parentID: "s1" }, [message("child-message")])
    index.write({ ...record("unrelated"), projectID: "p2" }, [])
    index.remove("s1")
    expect(index.write(record("s1", 1000), [metrics])).toBe(false)
    expect(index.write(record("child", 1000), [])).toBe(false)
    expect(index.write({ ...record("late-child", 1000), parentID: "s1" }, [])).toBe(false)
    expect(index.ids()).toEqual(["unrelated"])
    expect(index.db.query("SELECT * FROM messages").all()).toEqual([])
  } finally { index.close() }
})

test("shared source message IDs in forked history never steal or duplicate another session's text", async () => {
  const index = new SessionIndex(":memory:")
  try {
    index.write(record("original"), [message("shared", "original projection")])
    index.write(record("fork"), [message("shared", "fork projection")])
    index.write(record("fork"), [message("shared", "fork projection")])
    expect(await index.search({ query: "original projection", showSubagents: false })).toMatchObject([{ id: "original", messageCount: 1 }])
    expect(await index.search({ query: "fork projection", showSubagents: false })).toMatchObject([{ id: "fork", messageCount: 1 }])
    index.remove("fork")
    expect(await index.search({ query: "original projection", showSubagents: false })).toHaveLength(1)
  } finally { index.close() }
})

test("path defaults retain legacy data and additive migration preserves old text", async () => {
  expect(databasePath(undefined, "/state")).toBe("/state/opencode-sessions-all/sessions.sqlite")
  expect(databasePath("custom.sqlite", "/state")).toBe("/state/custom.sqlite")
  const dir = await mkdtemp(join(tmpdir(), "opcode-sessions-legacy-"))
  try {
    const path = join(dir, "sessions.sqlite")
    const old = new Database(path)
    old.run("CREATE TABLE messages (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,created_at INTEGER NOT NULL,text TEXT NOT NULL)")
    old.query("INSERT INTO messages VALUES (?,?,?,?,?)").run("old", "s1", "user", 2, "retained pre-migration text")
    old.close()
    const index = new SessionIndex(path)
    try {
      index.write(record(), [])
      expect(await index.search({ query: "pre-migration", showSubagents: false })).toMatchObject([{ snippet: "retained pre-migration text", messageCount: 1, cost: 0 }])
    } finally { index.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("disk tombstones survive reopening and new SQLite files/sidecars are private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opcode-sessions-disk-"))
  const nested = join(directory, "private")
  const path = join(nested, "sessions.sqlite")
  try {
    const index = new SessionIndex(path)
    try {
      index.write(record("parent"), [message("private-message", "fixture-only private text")])
      index.write({ ...record("child"), parentID: "parent" }, [])
      if (process.platform !== "win32") {
        expect((await stat(nested)).mode & 0o777).toBe(0o700)
        for (const file of [path, `${path}-wal`, `${path}-shm`]) expect((await stat(file)).mode & 0o777).toBe(0o600)
      }
      index.remove("parent")
    } finally { index.close() }
    const reopened = new SessionIndex(path)
    try {
      expect(reopened.write(record("parent", 1000), [message("late", "late snapshot")])).toBe(false)
      expect(reopened.write(record("child", 1000), [])).toBe(false)
      expect(reopened.write({ ...record("late-child", 1000), parentID: "parent" }, [])).toBe(false)
      expect(await reopened.search({ query: "", showSubagents: true })).toEqual([])
    } finally { reopened.close() }
    if (process.platform !== "win32") {
      await chmod(path, 0o640)
      await chmod(nested, 0o750)
      const existing = new SessionIndex(path)
      try {
        expect((await stat(path)).mode & 0o777).toBe(0o640)
        expect((await stat(nested)).mode & 0o777).toBe(0o750)
      } finally { existing.close() }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("catastrophic regex is terminated without blocking the server thread", async () => {
  const index = new SessionIndex(":memory:")
  const matcher = new RegexMatcher(30)
  try {
    index.write(record(), [message("bad", `${"a".repeat(80_000)}!`)])
    let responsive = false
    const timer = setTimeout(() => { responsive = true }, 20)
    await expect(matcher.match("(a+)+$", [{ id: "s1", title: "", directory: "", messages: [`${"a".repeat(80_000)}!`] }], 1)).rejects.toThrow("time budget")
    clearTimeout(timer)
    expect(responsive).toBe(true)
    expect(await index.search({ query: "", showSubagents: false })).toHaveLength(1)
  } finally { matcher.close(); index.close() }
})
