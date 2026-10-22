import { expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { createSnapshotRefresh, refreshesSnapshot, type RefreshState, type SetTimer } from "../src/refresh"
import { buildSnapshot, type Snapshot } from "../src/snapshot"

const snapshot = (sessionID: string) => buildSnapshot({ sessionID, messages: [] })
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Timers fire only when the test advances them. */
function manualTimers() {
  const pending = new Set<{ run: () => void; ms: number }>()
  const timer: SetTimer = (run, ms) => { const entry = { run, ms }; pending.add(entry); return () => pending.delete(entry) }
  return {
    timer,
    pending: (ms: number) => [...pending].filter((entry) => entry.ms === ms).length,
    async fire(ms: number) {
      for (const entry of [...pending].filter((entry) => entry.ms === ms)) { pending.delete(entry); entry.run() }
      await settle()
    },
  }
}

test("only completed changes in the open session trigger refreshes", () => {
  const event = (type: string, sessionID = "s") => ({ type, data: { sessionID } }) as unknown as OpenCodeEvent
  for (const type of ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta", "session.step.streamed", "session.status"]) {
    expect(refreshesSnapshot(event(type), "s")).toBe(false)
  }
  for (const type of ["session.step.ended", "session.tool.success", "session.usage.updated", "session.compaction.ended", "session.idle"]) {
    expect(refreshesSnapshot(event(type), "s")).toBe(true)
  }
  expect(refreshesSnapshot(event("session.step.ended", "other"), "s")).toBe(false)
  expect(refreshesSnapshot(event("session.step.ended"), undefined)).toBe(false)
})

test("new requests cancel old work and late completion cannot replace new data", async () => {
  const first = Promise.withResolvers<Snapshot>(), second = Promise.withResolvers<Snapshot>()
  const states: RefreshState[] = [], signals: AbortSignal[] = []
  const refresh = createSnapshotRefresh((signal) => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise }, (state) => states.push(state))
  const a = refresh.refresh(), b = refresh.refresh()
  expect(signals[0]?.aborted).toBe(true)
  second.resolve(snapshot("new")); await b
  first.resolve(snapshot("old")); await a
  expect(states.at(-1)?.snapshot?.sessionID).toBe("new")
  refresh.dispose()
})

test("disposal cancels active work and prevents subsequent publications or scheduled reads", async () => {
  const timers = manualTimers()
  const pending = Promise.withResolvers<Snapshot>()
  const states: RefreshState[] = []
  let signal: AbortSignal | undefined, calls = 0
  const refresh = createSnapshotRefresh((value) => { signal = value; calls++; return pending.promise }, (state) => states.push(state), { timer: timers.timer })
  const read = refresh.refresh()
  refresh.schedule(); refresh.dispose()
  pending.resolve(snapshot("late")); await read
  refresh.schedule()
  expect(timers.pending(120)).toBe(0)
  expect(signal?.aborted).toBe(true)
  expect(states).toHaveLength(1)
  expect(calls).toBe(1)
})

test("failures stop loading, preserve previous data as stale, and permit retry", async () => {
  let fail = false
  const states: RefreshState[] = []
  const refresh = createSnapshotRefresh(async () => { if (fail) throw new Error("offline"); return snapshot("s") }, (state) => states.push(state))
  await refresh.refresh(); fail = true; await refresh.refresh()
  expect(states.at(-1)).toMatchObject({ loading: false, error: "offline", snapshot: { sessionID: "s" } })
  fail = false; await refresh.refresh()
  expect(states.at(-1)?.error).toBeUndefined()
  refresh.dispose()
})

test("event bursts coalesce into one partial read and events during a read schedule one follow-up", async () => {
  const timers = manualTimers()
  const pending = Promise.withResolvers<Snapshot>()
  const reads: boolean[] = []
  const refresh = createSnapshotRefresh(async (_signal, full) => { reads.push(full); return reads.length === 1 ? pending.promise : snapshot("fresh") }, () => {}, { timer: timers.timer })
  refresh.schedule(); refresh.schedule(); refresh.schedule()
  expect(timers.pending(120)).toBe(1)
  await timers.fire(120)
  expect(reads).toEqual([false])
  refresh.schedule(); refresh.schedule()
  expect(timers.pending(120)).toBe(0)
  pending.resolve(snapshot("first")); await settle()
  expect(timers.pending(120)).toBe(1)
  await timers.fire(120)
  expect(reads).toEqual([false, false])
  await refresh.refresh()
  expect(reads).toEqual([false, false, true])
  refresh.dispose()
})

test("a load that never settles times out so later requests can run", async () => {
  const timers = manualTimers()
  const states: RefreshState[] = []
  let calls = 0, signal: AbortSignal | undefined
  const refresh = createSnapshotRefresh(async (value) => { calls++; signal = value; return calls === 1 ? new Promise<Snapshot>(() => {}) : snapshot("fresh") },
    (state) => states.push(state), { timer: timers.timer, timeout: 1000 })
  void refresh.refresh()
  refresh.schedule()
  expect(timers.pending(120)).toBe(0)
  await timers.fire(1000)
  expect(signal?.aborted).toBe(true)
  expect(states.at(-1)).toMatchObject({ loading: false, error: "Refresh timed out" })
  await timers.fire(120)
  expect(calls).toBe(2)
  expect(states.at(-1)).toMatchObject({ loading: false, snapshot: { sessionID: "fresh" } })
  refresh.dispose()
})
