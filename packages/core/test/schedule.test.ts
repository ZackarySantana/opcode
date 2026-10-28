import { expect, test } from "bun:test"
import { createSchedule } from "../src/schedule"
import { manualTimers } from "../test-support/server"

test("refreshes on the interval; a new interval, or a refresh by hand, restarts the countdown; a late wake refreshes within a tick", () => {
  const timers = manualTimers()
  let minutes = 10
  let refreshes = 0
  const schedule = createSchedule(() => { refreshes++; schedule.restart() }, () => minutes, { timer: timers.timer })
  expect(schedule.next()).toBeUndefined()
  // Nothing runs before it starts, even when the interval changes.
  schedule.reschedule()
  expect(timers.pending(10 * 60_000)).toBe(0)
  schedule.start()
  expect(refreshes).toBe(1)
  expect(Math.round((schedule.next()! - Date.now()) / 60_000)).toBe(10)

  minutes = 5
  schedule.reschedule()
  timers.fire(10 * 60_000)
  expect(refreshes).toBe(1)
  timers.fire(5 * 60_000)
  expect(refreshes).toBe(2)
  // Unchanged, the countdown keeps running.
  const next = schedule.next()
  schedule.reschedule()
  expect(schedule.next()).toBe(next)

  // Timers run late across sleep; a clock tick past the deadline refreshes.
  schedule.tick(schedule.next()! - 1)
  expect(refreshes).toBe(2)
  schedule.tick(schedule.next()! + 1)
  expect(refreshes).toBe(3)
  expect(timers.pending(5 * 60_000)).toBe(1)

  schedule.dispose()
  timers.fire(5 * 60_000)
  timers.fire(60_000)
  expect(refreshes).toBe(3)
})
