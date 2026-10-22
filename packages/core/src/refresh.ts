import { errorMessage } from "./index"

export type RefreshState<T> = { value?: T; loading: boolean; error?: string }
/** Starts a one-shot timer and returns its cancel function. */
export type SetTimer = (run: () => void, ms: number) => () => void

const setTimer: SetTimer = (run, ms) => { const id = setTimeout(run, ms); return () => clearTimeout(id) }

/**
 * One view's reads. `refresh` supersedes (aborts) the in-flight read; `schedule` debounces and coalesces
 * behind it into at most one follow-up, so bursts cannot starve long reads. The last good value survives
 * failures; `reset` drops it (e.g. for a different query). A read that outlives `timeout` is aborted.
 */
export function createRefresh<T, R = void>(load: (signal: AbortSignal, request: R) => Promise<T>, publish: (state: RefreshState<T>) => void,
  { delay = 120, timeout = 30_000, timer: start = setTimer }: { delay?: number; timeout?: number; timer?: SetTimer } = {}) {
  let state: RefreshState<T> = { loading: false }
  let generation = 0
  let disposed = false
  let active: AbortController | undefined
  let cancelTimer: (() => void) | undefined
  let pending: { request: R } | undefined
  const update = (next: RefreshState<T>) => { state = next; publish(next) }
  const arm = () => {
    cancelTimer ??= start(() => { cancelTimer = undefined; if (pending) void refresh(pending.request) }, delay)
  }
  const cancel = () => {
    generation++
    active?.abort()
    active = undefined
    cancelTimer?.()
    cancelTimer = undefined
    pending = undefined
  }
  const refresh = async (request: R) => {
    if (disposed) return
    cancel()
    const controller = new AbortController()
    active = controller
    const current = generation
    update({ ...state, loading: true }) // A previous failure stands until this read settles.
    const cancelTimeout = start(() => controller.abort(new Error("Refresh timed out")), timeout)
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }))
    try {
      const value = await Promise.race([load(controller.signal, request), aborted])
      if (current === generation) update({ value, loading: false })
    } catch (error) {
      if (current === generation) update({ value: state.value, loading: false, error: errorMessage(error) })
    } finally {
      cancelTimeout()
      if (current === generation) {
        active = undefined
        if (pending) arm()
      }
    }
  }
  return {
    refresh,
    schedule(request: R) {
      if (disposed) return
      pending = { request }
      if (!active) arm()
    },
    /** Abandons pending work and drops the last value; the caller starts the next read. */
    reset() {
      if (disposed) return
      cancel()
      update({ loading: false })
    },
    dispose() {
      disposed = true
      cancel()
    },
  }
}
