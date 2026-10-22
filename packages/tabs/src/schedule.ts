import { setTimer, type SetTimer } from "@opcode/core/refresh"
import { createSignal } from "solid-js"

/**
 * Runs `refresh` every `minutes()`, with a clock that ticks each minute so views age as time passes.
 * `refresh` should call `restart`: every refresh, automatic or not, restarts the countdown. Call `reschedule` when
 * the interval may have changed.
 */
export function createSchedule(refresh: () => void, minutes: () => number, timer: SetTimer = setTimer) {
  const [now, setNow] = createSignal(Date.now())
  const [next, setNext] = createSignal<number>()
  let cancelNext: (() => void) | undefined
  let cancelClock: (() => void) | undefined
  let disposed = false
  let scheduled = 0
  const tick = (at = Date.now()) => {
    setNow(at)
    // Timers can fall behind the wall clock across sleep (laptops, WSL); an overdue refresh starts within a tick.
    const due = next()
    if (due !== undefined && at >= due) refresh()
  }
  const restart = () => {
    cancelNext?.()
    if (disposed) return
    scheduled = minutes()
    const delay = scheduled * 60_000
    setNext(Date.now() + delay)
    cancelNext = timer(refresh, delay)
  }
  return {
    now,
    /** When the next automatic refresh starts; unset until `start`. */
    next,
    tick,
    restart,
    /** Refreshes now, then on the interval. */
    start() {
      const loop = () => { tick(); cancelClock = timer(loop, 60_000) }
      cancelClock = timer(loop, 60_000)
      refresh()
    },
    /** Restarts the countdown if the interval changed; a schedule that hasn't started stays stopped. */
    reschedule() { if (next() !== undefined && minutes() !== scheduled) restart() },
    dispose() {
      disposed = true
      cancelNext?.()
      cancelClock?.()
    },
  }
}

export type Schedule = ReturnType<typeof createSchedule>
