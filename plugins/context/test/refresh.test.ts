import { expect, test } from "bun:test"
import { createSnapshotRefresh, type RefreshState } from "../src/refresh"
import { buildSnapshot, type Snapshot } from "../src/snapshot"

const snapshot = (sessionID: string) => buildSnapshot({ sessionID, messages: [] })

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
  const pending = Promise.withResolvers<Snapshot>()
  const states: RefreshState[] = []
  let signal: AbortSignal | undefined, calls = 0
  const refresh = createSnapshotRefresh((value) => { signal = value; calls++; return pending.promise }, (state) => states.push(state), 1)
  const read = refresh.refresh()
  refresh.schedule(); refresh.dispose()
  pending.resolve(snapshot("late")); await read
  refresh.schedule(); await Bun.sleep(10)
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

test("event bursts coalesce and events during a read schedule one follow-up", async () => {
  const pending = Promise.withResolvers<Snapshot>()
  let calls = 0
  const refresh = createSnapshotRefresh(async () => { calls++; return calls === 1 ? pending.promise : snapshot("fresh") }, () => {}, 2)
  refresh.schedule(); refresh.schedule(); refresh.schedule()
  await Bun.sleep(10)
  expect(calls).toBe(1)
  refresh.schedule(); refresh.schedule()
  await Bun.sleep(10)
  expect(calls).toBe(1)
  pending.resolve(snapshot("first"))
  await Bun.sleep(15)
  expect(calls).toBe(2)
  refresh.dispose()
})
