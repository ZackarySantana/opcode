import { afterEach, expect, test } from "bun:test"
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
  expect(reopened.dashboard("all").total).toMatchObject({ cost: 0.75, messages: 1, output: 20, tokens: 33 })
  expect(reopened.lastImport(record.projectID)).toBeNumber()
})

test("live usage takes precedence over history; equal versions correct, older versions are ignored", () => {
  const ledger = open()
  ledger.recordLive({ ...record, cost: 9 }, 10)
  ledger.recordLive({ ...record, cost: 10 }, 10)
  ledger.recordLive({ ...record, cost: 0 }, 9)
  ledger.importBatch([{ ...record, cost: 1, completedAt: record.completedAt! + 100 }])
  expect(ledger.dashboard("all").total.cost).toBe(10)
})

test("committed writes notify; ignored live versions, failed batches, and reads do not", () => {
  let writes = 0
  const ledger = new CostLedger(":memory:", () => { writes++ })
  ledgers.push(ledger)
  ledger.recordLive(record, 10)
  ledger.recordLive(record, 9)
  expect(writes).toBe(1)
  ledger.importBatch([{ ...record, messageID: "history" }])
  expect(() => ledger.importBatch([{ ...record, messageID: "invalid", directory: null as unknown as string }])).toThrow("NOT NULL")
  ledger.recordActivity({ sessionID: record.sessionID, projectID: record.projectID, directory: record.directory, createdAt: 0 }, [{ kind: "idle", at: 1 }])
  ledger.dashboard("all")
  ledger.time("all")
  ledger.markImported(record.projectID, record.directory)
  expect(writes).toBe(3)
})

test("later historical completions replace history, but equal completions do not", () => {
  const ledger = open()
  ledger.importBatch([record])
  ledger.importBatch([{ ...record, cost: 2, completedAt: record.completedAt! + 100 }])
  ledger.importBatch([{ ...record, cost: 0, completedAt: record.completedAt! + 100 }])
  expect(ledger.dashboard("all").total.cost).toBe(2)
})

test("live precedence persists across separate connections and a reopen", () => {
  const path = temporaryDatabase()
  const first = open(path)
  const second = open(path)
  first.recordLive({ ...record, cost: 9 }, 10)
  second.importBatch([{ ...record, cost: 1, completedAt: record.completedAt! + 100 }])
  close(first)
  close(second)
  const reopened = open(path)
  reopened.importBatch([{ ...record, cost: 99, completedAt: record.completedAt! + 1_000 }])
  reopened.recordLive({ ...record, cost: 0 }, 9)
  expect(reopened.dashboard("all").total.cost).toBe(9)
  reopened.recordLive({ ...record, cost: 11 }, 10)
  expect(reopened.dashboard("all").total.cost).toBe(11)
})

test("live completion without usage keeps recorded usage but starts a new row from its record", () => {
  const ledger = open()
  ledger.recordLive({ ...record, cost: 0.3 }, 10)
  ledger.recordLive({ ...record, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, completedAt: record.completedAt! + 1 }, 11, { usage: false })
  ledger.recordLive({ ...record, messageID: "new", cost: 0 }, 11, { usage: false })
  expect(ledger.dashboard("all").total).toMatchObject({ cost: 0.3, messages: 2, tokens: 30 })
})

test("history can complete partial history but cannot regress completed records", () => {
  const ledger = open()
  ledger.importBatch([{ ...record, completedAt: undefined, cost: 0 }])
  ledger.importBatch([record, record])
  ledger.importBatch([{ ...record, completedAt: undefined, cost: 0 }, { ...record, completedAt: record.completedAt! - 1, cost: 0 }])
  expect(ledger.dashboard("all").total).toMatchObject({ cost: 0.5, messages: 1, tokens: 15 })
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
  expect(ledger.dashboard("all")).toMatchObject({
    total: { cost: 3.5, messages: 3, tokens: 45 },
    projects: [{ id: record.projectID, label: "main" }],
    models: [{ id: "provider/model", label: "provider/model" }],
  })
  ledger.recordLive({ ...record, cost: 9 }, 10)
  ledger.importBatch([{ ...record, sessionID: "fork", completedAt: record.completedAt! + 2_000, cost: 0 }])
  expect(ledger.dashboard("all").total.cost).toBe(12)
})

test("database write failures still roll back the entire import batch", () => {
  const ledger = open()
  ledger.importBatch([record])
  expect(() => ledger.importBatch([
    { ...record, messageID: "new" }, { ...record, messageID: "invalid", directory: null as unknown as string },
  ])).toThrow("NOT NULL")
  expect(ledger.dashboard("all").total.messages).toBe(1)
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
  expect(ledger.dashboard("all").projects).toMatchObject([{ id: moved.projectID, label: "destination", messages: 3, cost: 10.5 }])
})

test("date ranges start at local midnights", () => {
  const ledger = open()
  const now = new Date(2026, 6, 10, 18).getTime()
  expect(rangeStart("today", now)).toBe(new Date(2026, 6, 10).getTime())
  expect(rangeStart("7d", now)).toBe(new Date(2026, 6, 4).getTime())
  expect(rangeStart("30d", now)).toBe(new Date(2026, 5, 11).getTime())
  for (const [id, createdAt, cost] of [
    ["today", new Date(2026, 6, 10).getTime(), 1],
    ["week", new Date(2026, 6, 4).getTime(), 2],
    ["before-week", new Date(2026, 6, 4).getTime() - 1, 4],
    ["month", new Date(2026, 5, 11).getTime(), 8],
    ["before-month", new Date(2026, 5, 11).getTime() - 1, 16],
  ] as const) ledger.importBatch([{ ...record, messageID: id, createdAt, cost }])
  expect(ledger.dashboard("today", now).total.cost).toBe(1)
  expect(ledger.dashboard("7d", now).total.cost).toBe(3)
  expect(ledger.dashboard("30d", now).total.cost).toBe(15)
})

test("breakdowns list every project, model, and date, ranked by cost then tokens", () => {
  const ledger = open()
  for (let index = 1; index <= 20; index++) ledger.importBatch([{
    ...record, messageID: `m${index}`, projectID: `p${index}`, directory: `/work/p${index}`, modelID: `model${index}`,
    createdAt: new Date(2026, 6, index).getTime(), cost: index,
  }])
  const dashboard = ledger.dashboard("all")
  expect(dashboard.total).toMatchObject({ cost: 210, messages: 20, tokens: 300 })
  expect(dashboard.projects).toHaveLength(20)
  expect(dashboard.models[0]?.id).toBe("provider/model20")
  expect(dashboard.daily).toHaveLength(20)
  const free = open()
  free.importBatch([{ ...record, messageID: "small", cost: 0, input: 1 }, { ...record, messageID: "large", variant: "high", cost: 0, input: 100 }])
  // Variants split models, as on the time side.
  expect(free.dashboard("all").models.map((model) => model.id)).toEqual(["provider/model (high)", "provider/model"])
})

test("projects are named after their most recently used directory and include their worktrees", () => {
  const ledger = open()
  ledger.importBatch([
    { ...record, messageID: "worktree", projectID: "project-a", directory: "/worktrees/feature", createdAt: record.createdAt + 1 },
    { ...record, messageID: "other-project", projectID: "project-b", directory: "/projects/b/main" },
    { ...record, messageID: "main", projectID: "project-a", directory: "/projects/a/main" },
  ])
  expect(ledger.dashboard("all").projects).toMatchObject([
    { id: "project-a", label: "feature", messages: 2, cost: 1 },
    { id: "project-b", label: "main", messages: 1 },
  ])
})

test("daily buckets follow local midnights across a DST change", () => {
  const timezone = process.env.TZ
  process.env.TZ = "America/New_York"
  try {
    const ledger = open()
    // 2026-03-08 has 23 local hours; a fixed 24-hour bucket would misplace the late entries.
    for (const [id, createdAt, cost] of [
      ["before", new Date(2026, 2, 7, 23, 59).getTime(), 1],
      ["start", new Date(2026, 2, 8, 0, 0).getTime(), 2],
      ["end", new Date(2026, 2, 8, 23, 59).getTime(), 4],
      ["after", new Date(2026, 2, 9, 0, 0).getTime(), 8],
    ] as const) ledger.importBatch([{ ...record, messageID: id, createdAt, cost }])
    expect(ledger.dashboard("all").daily.map(({ id, cost }) => [id, cost])).toEqual([
      ["2026-03-09", 8], ["2026-03-08", 6], ["2026-03-07", 1],
    ])
  } finally {
    if (timezone === undefined) delete process.env.TZ
    else process.env.TZ = timezone
  }
})
