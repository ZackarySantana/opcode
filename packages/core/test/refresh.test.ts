import { expect, test } from "bun:test"
import { createRefresh, type RefreshState, type SetTimer } from "../src/refresh"

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

test("new requests cancel old work and late completion cannot replace new data", async () => {
  const first = Promise.withResolvers<string>(), second = Promise.withResolvers<string>()
  const states: RefreshState<string>[] = [], signals: AbortSignal[] = []
  const refresh = createRefresh((signal) => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise }, (state) => states.push(state))
  const a = refresh.refresh(), b = refresh.refresh()
  expect(signals[0]?.aborted).toBe(true)
  await a // Superseded reads settle without waiting for a transport that ignores cancellation.
  second.resolve("new"); await b
  first.resolve("old"); await settle()
  expect(states.at(-1)).toEqual({ value: "new", loading: false })
  refresh.dispose()
})

test("disposal cancels active work and prevents subsequent publications or scheduled reads", async () => {
  const timers = manualTimers()
  const states: RefreshState<string>[] = []
  let signal: AbortSignal | undefined, calls = 0
  const refresh = createRefresh((value) => { signal = value; calls++; return new Promise<string>(() => {}) }, (state) => states.push(state), { timer: timers.timer })
  const read = refresh.refresh()
  refresh.schedule(); refresh.dispose()
  await read
  refresh.schedule(); await refresh.refresh(); refresh.reset()
  expect(timers.pending(120) + timers.pending(30_000)).toBe(0)
  expect(signal?.aborted).toBe(true)
  expect(states).toEqual([{ loading: true }])
  expect(calls).toBe(1)
})

test("failures stop loading, keep the last good value until a retry succeeds", async () => {
  let fail = false
  const states: RefreshState<string>[] = []
  const retry = Promise.withResolvers<string>()
  const refresh = createRefresh(() => fail ? Promise.reject(new Error("offline")) : retry.promise, (state) => states.push(state))
  retry.resolve("s")
  await refresh.refresh(); fail = true; await refresh.refresh()
  expect(states.at(-1)).toEqual({ value: "s", loading: false, error: "offline" })
  fail = false
  const read = refresh.refresh()
  expect(states.at(-1)).toEqual({ value: "s", loading: true, error: "offline" })
  await read
  expect(states.at(-1)).toEqual({ value: "s", loading: false })
  refresh.dispose()
})

test("bursts coalesce into one debounced read, and requests during a read schedule one follow-up with the latest argument", async () => {
  const timers = manualTimers()
  const pending = Promise.withResolvers<string>()
  const reads: string[] = []
  const refresh = createRefresh<string, string>(async (_signal, request) => { reads.push(request); return reads.length === 1 ? pending.promise : "fresh" }, () => {}, { timer: timers.timer })
  refresh.schedule("a"); refresh.schedule("b"); refresh.schedule("c")
  expect(timers.pending(120)).toBe(1)
  await timers.fire(120)
  expect(reads).toEqual(["c"])
  refresh.schedule("d"); refresh.schedule("e")
  expect(timers.pending(120)).toBe(0)
  pending.resolve("first"); await settle()
  expect(timers.pending(120)).toBe(1)
  await timers.fire(120)
  expect(reads).toEqual(["c", "e"])
  refresh.schedule("f")
  await refresh.refresh("manual")
  expect(timers.pending(120)).toBe(0)
  expect(reads).toEqual(["c", "e", "manual"])
  refresh.dispose()
})

test("a load that never settles times out so later requests can run", async () => {
  const timers = manualTimers()
  const states: RefreshState<string>[] = []
  let calls = 0, signal: AbortSignal | undefined
  const refresh = createRefresh(async (value) => { calls++; signal = value; return calls === 1 ? new Promise<string>(() => {}) : "fresh" },
    (state) => states.push(state), { timer: timers.timer, timeout: 1000 })
  void refresh.refresh()
  refresh.schedule()
  expect(timers.pending(120)).toBe(0)
  await timers.fire(1000)
  expect(signal?.aborted).toBe(true)
  expect(states.at(-1)).toMatchObject({ loading: false, error: "Refresh timed out" })
  await timers.fire(120)
  expect(calls).toBe(2)
  expect(states.at(-1)).toEqual({ value: "fresh", loading: false })
  refresh.dispose()
})

test("reset drops the last value and abandons pending work for a different query", async () => {
  const timers = manualTimers()
  const states: RefreshState<string>[] = []
  const old = Promise.withResolvers<string>()
  const signals: AbortSignal[] = []
  let query = "a"
  const refresh = createRefresh(async (signal) => { signals.push(signal); return signals.length === 2 ? old.promise : query }, (state) => states.push(state), { timer: timers.timer })
  await refresh.refresh()
  void refresh.refresh(); refresh.schedule()
  query = "b"
  refresh.reset()
  expect(signals[1]?.aborted).toBe(true)
  expect(states.at(-1)).toEqual({ loading: false })
  expect(timers.pending(120)).toBe(0)
  const read = refresh.refresh()
  expect(states.at(-1)).toEqual({ loading: true })
  old.resolve("stale"); await read
  expect(states.at(-1)).toEqual({ value: "b", loading: false })
  refresh.dispose()
})
