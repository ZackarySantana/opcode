import { setTimer, type SetTimer } from "./refresh"

/**
 * Runs `refresh` every `minutes()`, with a clock that ticks each minute. `refresh` should call `restart`: every refresh,
 * automatic or not, restarts the countdown. Call `reschedule` when the interval may have changed. Not reactive: `tick`
 * and `next` report changes for views that need them.
 */
export function createSchedule(refresh: () => void, minutes: () => number, options: {
  timer?: SetTimer
  /** Each clock tick, with its time. */
  tick?: (at: number) => void
  /** Each change to when the next automatic refresh starts. */
  next?: (at: number) => void
} = {}) {
  const timer = options.timer ?? setTimer
  let next: number | undefined
  let cancelNext: (() => void) | undefined
  let cancelClock: (() => void) | undefined
  let disposed = false
  let scheduled = 0
  const tick = (at = Date.now()) => {
    options.tick?.(at)
    // Timers can fall behind the wall clock across sleep (laptops, WSL); an overdue refresh starts within a tick.
    if (next !== undefined && at >= next) refresh()
  }
  const restart = () => {
    cancelNext?.()
    if (disposed) return
    scheduled = minutes()
    const delay = scheduled * 60_000
    next = Date.now() + delay
    options.next?.(next)
    cancelNext = timer(refresh, delay)
  }
  return {
    /** When the next automatic refresh starts; unset until `start`. */
    next: () => next,
    tick,
    restart,
    /** Refreshes now, then on the interval. */
    start() {
      const loop = () => { tick(); cancelClock = timer(loop, 60_000) }
      cancelClock = timer(loop, 60_000)
      refresh()
    },
    /** Restarts the countdown if the interval changed; a schedule that hasn't started stays stopped. */
    reschedule() { if (next !== undefined && minutes() !== scheduled) restart() },
    dispose() {
      disposed = true
      cancelNext?.()
      cancelClock?.()
    },
  }
}

export type Schedule = ReturnType<typeof createSchedule>
