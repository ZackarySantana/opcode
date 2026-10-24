import { expect, test } from "bun:test"
import type { TimedSession, UsageRecord } from "../src/domain.js"
import { CostLedger } from "../src/ledger.js"
import { record } from "./fixtures.js"

const at = (hour: number, minute: number, second = 0, day = 10) => new Date(2026, 6, day, hour, minute, second).getTime()
const minutes = (value: number) => value * 60_000

test("root-session timelines derive turns, capped waits, overlap, and model attribution", () => {
  const ledger = new CostLedger(":memory:")
  const main: TimedSession = { sessionID: "main", projectID: "p", directory: "/work/main", title: "Fix login", createdAt: at(9, 0) }
  const other: TimedSession = { sessionID: "other", projectID: "q", directory: "/work/other", createdAt: at(9, 0) }
  // A fork inherits its parent's history, timestamps included; only its own activity counts.
  const fork: TimedSession = { ...main, sessionID: "fork", title: "Fork", createdAt: at(11, 0) }
  let id = 0
  const step = (session: TimedSession, start: number, end: number, modelID: string, output: number, variant?: string): UsageRecord => ({
    ...record, messageID: `m${id++}`, sessionID: session.sessionID, projectID: session.projectID, directory: session.directory,
    modelID, variant, createdAt: start, completedAt: end, output, reasoning: 0,
  })
  try {
    ledger.recordActivity(main, [
      { kind: "prompt", at: at(10, 0) },
      { kind: "prompt", at: at(10, 3) }, // Steered in while busy: the same turn.
      { kind: "idle", at: at(10, 10) },
      { kind: "prompt", at: at(10, 10) }, // Delivered as the session went idle: a new turn, no wait.
      { kind: "idle", at: at(10, 19) },
      // 10:40 a background subagent wakes the session: no prompt, so no waiting gap.
      { kind: "idle", at: at(10, 45) },
      { kind: "prompt", at: at(23, 0) }, // Hours later: capped at 30 minutes.
      // The 23:00 turn never went idle (server shutdown); the next morning's prompt starts a new turn.
      { kind: "prompt", at: at(9, 0, 0, 11) },
      { kind: "idle", at: at(9, 2, 0, 11) },
    ])
    ledger.importBatch([
      step(main, at(10, 0, 1), at(10, 2), "small", 100),
      step(main, at(10, 3, 1), at(10, 9), "large", 500, "high"),
      step(main, at(10, 10, 1), at(10, 16), "small", 10),
      step(main, at(10, 40), at(10, 41), "small", 10),
      step(main, at(23, 0, 1), at(23, 5), "small", 10),
      step(main, at(9, 0, 1, 11), at(9, 1, 0, 11), "small", 10),
      step(other, at(10, 5, 1), at(10, 6), "small", 10),
    ])
    ledger.recordActivity(other, [{ kind: "prompt", at: at(10, 5) }, { kind: "idle", at: at(10, 8) }])
    ledger.recordActivity(fork, [
      { kind: "prompt", at: at(10, 0) }, { kind: "idle", at: at(10, 10) },
      { kind: "prompt", at: at(11, 0) }, { kind: "idle", at: at(11, 1) },
    ])

    const all = ledger.time({ range: "all" })
    // main: 10 + 9 + 5 + 5 + 2 minutes; other: 3; fork: 1.
    expect(all.total).toEqual({ agent: minutes(35), turns: 7, wait: minutes(30), parallel: minutes(3), peak: 2 })
    expect(all.longest[0]).toEqual({
      sessionID: "main", title: "Fix login", project: "main", directory: "/work/main",
      model: "provider/large (high)", start: at(10, 0), duration: minutes(10),
    })
    expect(all.models.map(({ label, agent, turns }) => ({ label, agent, turns }))).toEqual([
      { label: "provider/small", agent: minutes(24), turns: 5 },
      { label: "provider/large (high)", agent: minutes(10), turns: 1 },
      { label: "no recorded step", agent: minutes(1), turns: 1 },
    ])
    expect(all.daily.map(({ id, agent }) => ({ id, agent }))).toEqual([
      { id: "2026-07-11", agent: minutes(2) }, { id: "2026-07-10", agent: minutes(33) },
    ])

    expect(ledger.time({ range: "all", model: "provider/large" }).total).toMatchObject({ agent: minutes(10), wait: 0, turns: 1 })
    expect(ledger.time({ range: "all", projectID: "q" }).total).toEqual({ agent: minutes(3), turns: 1, wait: 0, parallel: 0, peak: 1 })
    expect(ledger.time({ range: "today" }, at(12, 0, 0, 11)).total).toMatchObject({ agent: minutes(2), turns: 1 })
  } finally { ledger.close() }
})
