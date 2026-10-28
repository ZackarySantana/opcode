import { expect, test } from "bun:test"
import { createThrottle } from "../src/throttle.js"

function fakeTimer() {
  const timers = new Set<{ run(): void }>()
  return {
    timer: (run: () => void) => {
      const entry = { run }
      timers.add(entry)
      return () => { timers.delete(entry) }
    },
    pending: () => timers.size,
    /** Fires every armed timer once, like the interval passing. */
    elapse() {
      const due = [...timers]
      timers.clear()
      for (const entry of due) entry.run()
    },
  }
}

test("the first call runs at once; calls during the interval coalesce into one run at its end", () => {
  const clock = fakeTimer()
  let runs = 0
  const throttle = createThrottle(() => { runs++ }, 1_000, clock.timer)
  throttle.notify()
  expect(runs).toBe(1)
  throttle.notify()
  throttle.notify()
  expect(runs).toBe(1)
  clock.elapse()
  expect(runs).toBe(2)
  // The trailing run starts another interval: a quiet interval ends it without running.
  throttle.notify()
  expect(runs).toBe(2)
  clock.elapse()
  expect(runs).toBe(3)
  clock.elapse()
  expect(runs).toBe(3)
  expect(clock.pending()).toBe(0)
  throttle.notify()
  expect(runs).toBe(4)
})

test("dispose cancels a pending run and ignores later calls", () => {
  const clock = fakeTimer()
  let runs = 0
  const throttle = createThrottle(() => { runs++ }, 1_000, clock.timer)
  throttle.notify()
  throttle.notify()
  throttle.dispose()
  expect(clock.pending()).toBe(0)
  clock.elapse()
  throttle.notify()
  expect(runs).toBe(1)
})
