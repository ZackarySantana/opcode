import { expect, test } from "bun:test"
import { manualTimers } from "@opcode/core/test-support/server"
import { createClock } from "../src/clock"

test("the clock ticks every minute until disposed", () => {
  const timers = manualTimers()
  const ticks: number[] = []
  const clock = createClock({ timer: timers.timer, tick: (at) => ticks.push(at) })
  const start = clock.now()
  timers.fire(60_000)
  timers.fire(60_000)
  expect(ticks).toHaveLength(2)
  expect(clock.now()).toBe(ticks[1]!)
  expect(clock.now()).toBeGreaterThanOrEqual(start)
  clock.dispose()
  expect(timers.pending(60_000)).toBe(0)
  timers.fire(60_000)
  expect(ticks).toHaveLength(2)
})

test("disposing from a tick stops the clock", () => {
  const timers = manualTimers()
  const clock = createClock({ timer: timers.timer, tick: () => clock.dispose() })
  timers.fire(60_000)
  expect(timers.pending(60_000)).toBe(0)
})
