import { errorMessage } from "@opcode/core"
import type { Snapshot } from "./snapshot"

export type RefreshState = { snapshot?: Snapshot; loading: boolean; error?: string }

/** Owns this dialog's requests and timer; event refreshes coalesce without starving long reads. */
export function createSnapshotRefresh(load: (signal: AbortSignal) => Promise<Snapshot>, publish: (state: RefreshState) => void, delay = 120) {
  let state: RefreshState = { loading: false }
  let generation = 0
  let disposed = false
  let active: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let queued = false
  const update = (next: RefreshState) => { state = next; publish(next) }
  const schedule = () => {
    if (disposed) return
    if (active) { queued = true; return }
    timer ??= setTimeout(() => { timer = undefined; void refresh() }, delay)
  }
  const refresh = async () => {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = undefined
    queued = false
    active?.abort()
    const controller = new AbortController()
    active = controller
    const request = ++generation
    update({ snapshot: state.snapshot, loading: true })
    try {
      const snapshot = await load(controller.signal)
      if (!disposed && request === generation) update({ snapshot, loading: false })
    } catch (error) {
      if (!disposed && request === generation) update({ snapshot: state.snapshot, loading: false, error: errorMessage(error) })
    } finally {
      if (!disposed && request === generation) {
        active = undefined
        if (queued) schedule()
      }
    }
  }
  return {
    refresh, schedule,
    dispose() {
      disposed = true
      generation++
      active?.abort()
      if (timer) clearTimeout(timer)
    },
  }
}
