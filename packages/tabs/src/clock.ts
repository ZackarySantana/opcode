import { setTimer, type SetTimer } from "@opcode/core/refresh"
import { createSignal, type Accessor } from "solid-js"

/** A clock that ticks each minute, as a signal, so views age as time passes. `tick` runs after each tick, with its time. */
export function createClock(options: { timer?: SetTimer; tick?: (at: number) => void } = {}): { now: Accessor<number>; dispose(): void } {
  const timer = options.timer ?? setTimer
  const [now, setNow] = createSignal(Date.now())
  let disposed = false
  let cancel = () => {}
  const loop = () => {
    if (disposed) return
    const at = Date.now()
    setNow(at)
    options.tick?.(at)
    if (!disposed) cancel = timer(loop, 60_000)
  }
  cancel = timer(loop, 60_000)
  return {
    now,
    dispose() {
      disposed = true
      cancel()
    },
  }
}
