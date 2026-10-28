import { setTimer, type SetTimer } from "@opcode/core/refresh"

/** Runs at once, then at most once per interval: calls during an interval coalesce into one run at its end. */
export function createThrottle(run: () => void, interval: number, timer: SetTimer = setTimer) {
  let cancel: (() => void) | undefined
  let pending = false
  let disposed = false
  const wait = () => {
    cancel = timer(() => {
      cancel = undefined
      if (!pending) return
      pending = false
      run()
      wait()
    }, interval)
  }
  return {
    notify() {
      if (disposed) return
      if (cancel) { pending = true; return }
      run()
      wait()
    },
    dispose() {
      disposed = true
      cancel?.()
      cancel = undefined
    },
  }
}
