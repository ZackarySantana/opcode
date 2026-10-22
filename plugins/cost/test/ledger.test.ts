import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CostLedger, databasePath } from "../src/ledger.js"
import { rangeStart } from "../src/domain.js"
import { record } from "./fixtures.js"

const ledgers: CostLedger[] = []
const directories: string[] = []
function open(path = ":memory:") {
  const ledger = new CostLedger(path)
  ledgers.push(ledger)
  return ledger
}
function close(ledger: CostLedger) {
  ledgers.splice(ledgers.indexOf(ledger), 1)
  ledger.close()
}
function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "opcode-cost-"))
  directories.push(directory)
  return join(directory, "cost.sqlite")
}
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("legacy default path and configurable server paths", () => {
  expect(databasePath(undefined, "/state")).toBe("/state/opencode-cost/cost.sqlite")
  expect(databasePath(" custom.sqlite ", "/state")).toBe("/state/custom.sqlite")
  expect(databasePath("/absolute/file.sqlite", "/state")).toBe("/absolute/file.sqlite")
  expect(databasePath(1, "/state")).toBe("/state/opencode-cost/cost.sqlite")
  expect(databasePath(":memory:")).toBe(":memory:")
})

test("revisions are idempotent, persist on reopen, and survive session deletion independently", () => {
  const path = temporaryDatabase()
  const ledger = new CostLedger(path)
  ledger.recordLive(record, 10)
  ledger.recordLive({ ...record, cost: 0.75, output: 20 }, 20)
  ledger.recordLive({ ...record, cost: 0.1 }, 5)
  ledger.markImported(record.projectID, record.directory)
  ledger.close()
  const reopened = open(path)
  expect(reopened.dashboard({ range: "all" }).total).toMatchObject({ cost: 0.75, messages: 1, output: 20, tokens: 33 })
  expect(reopened.lastImport(record.projectID)).toBeNumber()
})

test("later historical completions and equal-version live corrections work; live precedence survives a true reopen", () => {
  const path = temporaryDatabase()
  const first = open(path)
  first.recordLive({ ...record, cost: 9 }, 10)
  const second = open(path)
  first.recordLive({ ...record, cost: 10 }, 10) // Equal-version corrections are not mistaken for older events.
  first.recordLive({ ...record, cost: 0 }, 9)
  second.importBatch([{ ...record, cost: 1, completedAt: record.completedAt! + 100 }])
  const historical = { ...record, messageID: "historical", modelID: "history" }
  second.importBatch([historical])
  second.importBatch([{ ...historical, cost: 2, completedAt: record.completedAt! + 100 }])
  second.importBatch([{ ...historical, cost: 0, completedAt: record.completedAt! + 100 }])
  expect(first.dashboard({ range: "all", model: "provider/history" }).total.cost).toBe(2)
  expect(first.dashboard({ range: "all" }).total).toMatchObject({ cost: 12, messages: 2 })
  close(first)
  close(second)
  const reopened = open(path)
  reopened.importBatch([{ ...record, cost: 99, completedAt: record.completedAt! + 1_000 }])
  reopened.recordLive({ ...record, cost: 0 }, 9)
  expect(reopened.dashboard({ range: "all" }).total.cost).toBe(12)
  reopened.recordLive({ ...record, cost: 11 }, 10)
  expect(reopened.dashboard({ range: "all" }).total.cost).toBe(13)
})

test("history can complete partial history but cannot regress completed records", () => {
  const ledger = open()
  ledger.importBatch([{ ...record, completedAt: undefined, cost: 0 }])
  ledger.importBatch([record, record])
  ledger.importBatch([{ ...record, completedAt: undefined, cost: 0 }, { ...record, completedAt: record.completedAt! - 1, cost: 0 }])
  expect(ledger.dashboard({ range: "all" }).total).toMatchObject({ cost: 0.5, messages: 1, tokens: 15 })
})

test("cross-session message IDs are skipped without changing usage/attribution or rejecting other records", () => {
  const ledger = open()
  ledger.importBatch([record])
  ledger.importBatch([
    { ...record, messageID: "before", cost: 1 },
    { ...record, sessionID: "another-session", projectID: "other-project", directory: "/other",
      providerID: "other-provider", modelID: "other-model", createdAt: record.createdAt + 1,
      completedAt: record.completedAt! + 1_000, cost: 99, input: 999 },
    { ...record, messageID: "after", cost: 2 },
  ])
  expect(ledger.dashboard({ range: "all" })).toMatchObject({
    total: { cost: 3.5, messages: 3, tokens: 45 },
    projectOptions: [{ id: record.projectID, label: "main" }],
    modelOptions: [{ id: "provider/model", label: "provider/model" }],
  })
  ledger.recordLive({ ...record, cost: 9 }, 10)
  ledger.importBatch([{ ...record, sessionID: "fork", completedAt: record.completedAt! + 2_000, cost: 0 }])
  expect(ledger.dashboard({ range: "all" }).total.cost).toBe(12)
})

test("database write failures still roll back the entire import batch", () => {
  const ledger = open()
  ledger.importBatch([record])
  expect(() => ledger.importBatch([
    { ...record, messageID: "new" }, { ...record, messageID: "invalid", directory: null as unknown as string },
  ])).toThrow("NOT NULL")
  expect(ledger.dashboard({ range: "all" }).total.messages).toBe(1)
})

test("session moves reattribute history and protected live usage without rejecting other batch records", () => {
  const ledger = open()
  ledger.recordLive({ ...record, cost: 9 }, 10)
  ledger.importBatch([{ ...record, messageID: "historical" }])
  const moved = { projectID: "destination", directory: "/work/destination" }
  ledger.importBatch([
    { ...record, ...moved, messageID: "new-message", cost: 1 },
    { ...record, ...moved, cost: 0 },
    { ...record, ...moved, messageID: "historical", cost: 0 },
  ])
  expect(ledger.dashboard({ range: "all", projectID: record.projectID }).total.messages).toBe(0)
  expect(ledger.dashboard({ range: "all", projectID: moved.projectID })).toMatchObject({
    total: { messages: 3, cost: 10.5 }, projectOptions: [{ id: moved.projectID, label: "destination" }],
  })
})

test("opens unchanged legacy usage/backfill tables without discarding data or markers", () => {
  const path = temporaryDatabase()
  const legacy = new Database(path)
  legacy.run(`CREATE TABLE usage (
    message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL, directory TEXT NOT NULL,
    provider_id TEXT NOT NULL, model_id TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER,
    cost REAL NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, recorded_at INTEGER NOT NULL);
    CREATE TABLE backfill (project_id TEXT PRIMARY KEY, directory TEXT NOT NULL, completed_at INTEGER NOT NULL);`)
  legacy.query("INSERT INTO usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    record.messageID, record.sessionID, record.projectID, record.directory, record.providerID, record.modelID,
    record.createdAt, record.completedAt!, record.cost, record.input, record.output, record.reasoning, record.cacheRead, record.cacheWrite, 123,
  )
  legacy.query("INSERT INTO backfill VALUES (?, ?, ?)").run(record.projectID, record.directory, 123)
  legacy.close()
  const ledger = open(path)
  expect(ledger.dashboard({ range: "all" }).total).toMatchObject({ messages: 1, cost: record.cost, tokens: 15 })
  expect(ledger.lastImport(record.projectID)).toBe(123)
  ledger.importBatch([{ ...record, cost: 0 }])
  expect(ledger.dashboard({ range: "all" }).total.cost).toBe(record.cost)
})

test("local-calendar boundaries and combined date/project/model filters", () => {
  const ledger = open()
  const now = new Date(2026, 6, 10, 18).getTime()
  expect(rangeStart("today", now)).toBe(new Date(2026, 6, 10).getTime())
  expect(rangeStart("7d", now)).toBe(new Date(2026, 6, 4).getTime())
  expect(rangeStart("30d", now)).toBe(new Date(2026, 5, 11).getTime())
  for (const [id, createdAt, projectID, modelID, cost] of [
    ["today", new Date(2026, 6, 10).getTime(), "a", "one", 1],
    ["week", new Date(2026, 6, 4).getTime(), "a", "two", 2],
    ["before-week", new Date(2026, 6, 4).getTime() - 1, "b", "one", 4],
    ["month", new Date(2026, 5, 11).getTime(), "b", "one", 8],
    ["before-month", new Date(2026, 5, 11).getTime() - 1, "b", "one", 16],
  ] as const) ledger.importBatch([{ ...record, messageID: id, createdAt, projectID, modelID, cost }])
  expect(ledger.dashboard({ range: "today" }, now).total.cost).toBe(1)
  expect(ledger.dashboard({ range: "7d" }, now).total.cost).toBe(3)
  expect(ledger.dashboard({ range: "30d" }, now).total.cost).toBe(15)
  expect(ledger.dashboard({ range: "all", projectID: "a", model: "provider/two" }, now).total.cost).toBe(2)
  const empty = ledger.dashboard({ range: "all", projectID: "missing" }, now)
  expect(empty.total).toMatchObject({ cost: 0, messages: 0, tokens: 0 })
  expect(empty.projectOptions).toHaveLength(2)
})

test("breakdowns are bounded, daily dates chronological, and totals remain complete", () => {
  const ledger = open()
  for (let index = 1; index <= 20; index++) ledger.importBatch([{
    ...record, messageID: `m${index}`, projectID: `p${index}`, directory: `/work/p${index}`, modelID: `model${index}`,
    createdAt: new Date(2026, 6, index).getTime(), cost: index,
  }])
  const dashboard = ledger.dashboard({ range: "all" })
  expect(dashboard.total).toMatchObject({ cost: 210, messages: 20, tokens: 300 })
  expect(dashboard.projects).toHaveLength(8)
  expect(dashboard.models[0]?.id).toBe("provider/model20")
  expect(dashboard.daily).toHaveLength(14)
  expect(dashboard.daily[0]?.id).toBe("2026-07-07")
  expect(dashboard.daily.at(-1)?.id).toBe("2026-07-20")
})

test("project options distinguish matching names by path and retain project-wide worktree filtering", () => {
  const ledger = open()
  ledger.importBatch([
    { ...record, messageID: "worktree", projectID: "project-a", directory: "/worktrees/feature/main" },
    { ...record, messageID: "other-project", projectID: "project-b", directory: "/projects/b/main" },
    { ...record, messageID: "main", projectID: "project-a", directory: "/projects/a/main" },
  ])
  const dashboard = ledger.dashboard({ range: "all", projectID: "project-a" })
  expect(dashboard.projectOptions).toEqual([
    { id: "project-a", label: "main", directory: "/projects/a/main" },
    { id: "project-b", label: "main", directory: "/projects/b/main" },
  ])
  expect(dashboard.total).toMatchObject({ messages: 2, cost: 1 })
})
