import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionIndex, databasePath, observedNow } from "../src/index-store"
import { messageRecord } from "../src/domain"
import { RegexMatcher } from "../src/regex"
import { assistant, message, record } from "./fixtures"

const ids = async (index: SessionIndex, query: string) => (await index.search({ query, showSubagents: false })).rows

test("regex searches full text, title and directory; ordering and snippets use recency", async () => {
  const index = new SessionIndex(":memory:")
  try {
    index.write({ ...record("s1"), title: "Authentication" }, [message(), { ...message("m2", "new JWT rotation"), createdAt: 4 }])
    index.write({ ...record("s2", 200), projectID: "p2", directory: "/work/beta", title: "Dashboard" }, [message("other", "charts")])
    expect((await ids(index, "")).map((row) => row.id)).toEqual(["s2", "s1"])
    expect(await ids(index, "jwt.*(rotation|refresh)")).toMatchObject([{ id: "s1", snippet: "new JWT rotation" }])
    expect((await ids(index, "authentication|beta")).map((row) => row.id)).toEqual(["s2", "s1"])
    // Fields are matched separately, so anchors apply to the directory itself.
    expect((await ids(index, "^/work/beta$")).map((row) => row.id)).toEqual(["s2"])
    expect((await ids(index, "^Dashboard$")).map((row) => row.id)).toEqual(["s2"])
    expect(await index.search({ query: "JWT", projectID: "p2", showSubagents: false })).toEqual({ rows: [], truncated: false })
    await expect(index.search({ query: "[", showSubagents: false })).rejects.toThrow()
    await expect(index.search({ query: "x".repeat(257), showSubagents: false })).rejects.toThrow("256")
    // Limits count characters, like the RPC schema, not UTF-16 units; legacy escapes still compile.
    expect(await ids(index, "😀".repeat(256))).toEqual([])
    expect(await ids(index, "\\-")).toEqual([])
  } finally { index.close() }
})

test("search omits absent SQL identifiers before any JSON serialization", async () => {
  const index = new SessionIndex(":memory:")
  try {
    index.write(record("root", 200), [message("user", "No assistant model")])
    index.write({ ...record("child", 100), parentID: "root" }, [messageRecord(assistant())!])
    const [root, child] = (await index.search({ query: "", showSubagents: true })).rows
    for (const key of ["parentID", "providerID", "modelID"] as const) expect(Object.hasOwn(root!, key)).toBe(false)
    expect(child).toMatchObject({ parentID: "root", providerID: "openai", modelID: "test-model" })
  } finally { index.close() }
})

test("hides children before result limit, not after the newest children fill it", async () => {
  const index = new SessionIndex(":memory:")
  try {
    index.write(record("root", 1), [])
    for (let n = 0; n < 120; n++) index.write({ ...record(`child-${n}`, n + 2), parentID: "root" }, [])
    expect((await index.search({ query: "", showSubagents: false, limit: 1 })).rows).toMatchObject([{ id: "root" }])
    expect((await index.search({ query: "", showSubagents: true, limit: 1 })).rows).toMatchObject([{ id: "child-119" }])
  } finally { index.close() }
})

test("matching and project filtering precede the cap even with over 200 newer nonmatches", async () => {
  const index = new SessionIndex(":memory:")
  try {
    index.write(record("old-p1", 1), [message("p1-needle", "historical needle")])
    index.write({ ...record("old-p2", 2), projectID: "p2" }, [message("p2-needle", "historical needle")])
    for (let n = 0; n < 220; n++) index.write(record(`new-${n}`, n + 3), [message(`new-message-${n}`, "unrelated text")])
    expect((await index.search({ query: "historical.*needle", showSubagents: false, limit: 1 })).rows).toMatchObject([{ id: "old-p2" }])
    expect((await index.search({ query: "historical.*needle", projectID: "p1", showSubagents: false, limit: 1 })).rows).toMatchObject([{ id: "old-p1", snippet: "historical needle" }])
  } finally { index.close() }
})

test("upserts metrics once, rejects older snapshots, and tombstones deleted families", async () => {
  const index = new SessionIndex(":memory:")
  try {
    const metrics = messageRecord(assistant())!
    index.write(record(), [metrics]); index.write(record(), [metrics])
    expect(await ids(index, "")).toMatchObject([{ messageCount: 1, cost: 0.25, modelCount: 1, input: 100 }])
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
    expect(await ids(index, "original projection")).toMatchObject([{ id: "original", messageCount: 1 }])
    expect(await ids(index, "fork projection")).toMatchObject([{ id: "fork", messageCount: 1 }])
    index.remove("fork")
    expect(await ids(index, "original projection")).toHaveLength(1)
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
      expect(await ids(index, "pre-migration")).toMatchObject([{ snippet: "retained pre-migration text", messageCount: 1, cost: 0 }])
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
      expect((await reopened.search({ query: "", showSubagents: true })).rows).toEqual([])
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
    expect(await ids(index, "")).toHaveLength(1)
  } finally { matcher.close(); index.close() }
})

test("an expensive expression returns the matches found before its budget, marked partial", async () => {
  const index = new SessionIndex(":memory:")
  try {
    for (let n = 0; n < 16; n++) index.write(record(`slow-${n}`, 1), [message(`bad-${n}`, `${"a".repeat(40)}!`)])
    for (let n = 0; n < 16; n++) index.write(record(`fast-${n}`, n + 2), [message(`fast-message-${n}`, "aaa")])
    const result = await index.search({ query: "(a+)+$", showSubagents: false })
    expect(result.truncated).toBe(true)
    expect(result.rows).toHaveLength(16)
    // The reused matcher recovers after its worker was terminated.
    expect(await ids(index, "^aaa$")).toHaveLength(16)
  } finally { index.close() }
})

test("long previews center on the match without splitting graphemes", async () => {
  const index = new SessionIndex(":memory:")
  try {
    const family = "👨‍👩‍👧"
    const text = `xxx${family.repeat(1_000)}${"x".repeat(3_000)}NEEDLE${"y".repeat(3_000)}${family.repeat(1_000)}`
    index.write(record(), [message("long", text)])
    const [row] = await ids(index, "needle")
    expect(row!.snippet.length).toBeLessThanOrEqual(4096)
    expect(row!.snippet).toContain("NEEDLE")
    const at = row!.snippet.indexOf("NEEDLE")
    expect(Math.abs(at - (row!.snippet.length - at - 6))).toBeLessThan(16)
    const head = (await ids(index, ""))[0]!.snippet
    expect(head.length).toBeLessThanOrEqual(4096)
    // Every family emoji in the preview is whole.
    expect(head.replaceAll(family, "").replaceAll("x", "")).toBe("")
  } finally { index.close() }
})

test("a write survives another connection committing during its transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opcode-sessions-writers-"))
  const path = join(directory, "sessions.sqlite")
  const first = new SessionIndex(path)
  const second = new SessionIndex(path)
  try {
    second.db.run("PRAGMA busy_timeout=0")
    first.write(record("s1", 1), [])
    let competing: unknown
    // Commit from the second connection after the first has read inside its transaction.
    const session = { ...record("s1", 2), get updatedAt() { try { second.write(record("s2", 1), []) } catch (error) { competing = error } return 2 } }
    expect(first.write(session, [message()])).toBe(true)
    expect(competing).toBeDefined()
    second.write(record("s2", 1), [])
    expect(first.ids().sort()).toEqual(["s1", "s2"])
  } finally { first.close(); second.close(); await rm(directory, { recursive: true, force: true }) }
})

test("grandchildren of a deleted root stay out of the index even when the child was never indexed", async () => {
  const index = new SessionIndex(":memory:")
  try {
    index.write(record("root"), [])
    index.remove("root")
    expect(index.write({ ...record("child"), parentID: "root" }, [])).toBe(false)
    expect(index.write({ ...record("grandchild"), parentID: "child" }, [message("g", "grandchild text")])).toBe(false)
    index.write(record("other"), [])
    index.write({ ...record("other-child"), parentID: "other" }, [])
    index.remove("other")
    // An indexed chain tombstones through the family; a later great-grandchild checks every ancestor.
    expect(index.write({ ...record("other-grandchild"), parentID: "other-child" }, [])).toBe(false)
    expect(index.ids()).toEqual([])
  } finally { index.close() }
})

test("context writes prune reverted messages but keep compacted history", async () => {
  const index = new SessionIndex(":memory:")
  try {
    // Source IDs ascend with creation; history holds msg_1..msg_4, context starts after compaction.
    index.write(record("s1", 1), ["msg_1", "msg_2", "msg_3", "msg_4"].map((id) => message(id, `${id} text`)))
    index.write(record("s1", 2), [message("msg_3", "msg_3 text")], "msg_3")
    expect((await ids(index, "msg_"))[0]).toMatchObject({ messageCount: 3 })
    expect(await ids(index, "msg_4")).toEqual([])
    expect(await ids(index, "msg_1")).toHaveLength(1)
    // Fork projections are pruned by their own source IDs.
    index.write(record("fork", 1), [message("msg_2", "fork msg_2"), message("msg_9", "fork msg_9")])
    index.write(record("fork", 2), [], "msg_2")
    expect(await ids(index, "fork msg_9")).toEqual([])
    expect(await ids(index, "fork msg_2")).toHaveLength(1)
    // History uploads (no context boundary) never prune.
    index.write(record("s1", 2), [message("msg_0", "msg_0 text")])
    expect((await ids(index, "msg_")).find((row) => row.id === "s1")).toMatchObject({ messageCount: 4 })
  } finally { index.close() }
})

test("a tombstone yields only to a host read that began after the deletion", () => {
  const index = new SessionIndex(":memory:")
  try {
    index.write(record(), [])
    const before = observedNow()
    index.remove("s1")
    index.revive("s1", before)
    expect(index.write(record("s1", 200), [])).toBe(false)
    index.revive("s1", observedNow())
    expect(index.write(record("s1", 200), [])).toBe(true)
  } finally { index.close() }
})
