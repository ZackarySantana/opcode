import { errorMessage } from "@opcode/core"
import type { OpenCodeEvent } from "@opencode/client"
import type { Snapshot } from "./snapshot"

export type RefreshState = { snapshot?: Snapshot; loading: boolean; error?: string }
export type SetTimer = (run: () => void, ms: number) => () => void

/** Completed session changes; streaming deltas would otherwise reload history on every chunk. */
const refreshEvents = new Set<OpenCodeEvent["type"]>([
  "session.step.ended", "session.step.failed", "session.tool.success", "session.tool.failed", "session.usage.updated",
  "session.compaction.ended", "session.compaction.failed", "session.shell.ended",
  "session.synthetic", "session.skill.activated", "session.inbox.delivered", "session.agent.selected", "session.model.selected",
  "session.revert.committed", "session.revert.cleared", "session.moved", "session.execution.succeeded",
  "session.execution.failed", "session.execution.interrupted", "session.idle",
])

export function refreshesSnapshot(event: OpenCodeEvent, sessionID?: string) {
  return refreshEvents.has(event.type) && "sessionID" in event.data && event.data.sessionID === sessionID
}

const setTimer: SetTimer = (run, ms) => { const id = setTimeout(run, ms); return () => clearTimeout(id) }

/**
 * Owns this dialog's requests and timer; event refreshes coalesce without starving long reads.
 * Manual refreshes are `full` (environment included); event refreshes are not. A load that outlives `timeout` is abandoned.
 */
export function createSnapshotRefresh(load: (signal: AbortSignal, full: boolean) => Promise<Snapshot>, publish: (state: RefreshState) => void,
  { delay = 120, timeout = 30_000, timer: start = setTimer }: { delay?: number; timeout?: number; timer?: SetTimer } = {}) {
  let state: RefreshState = { loading: false }
  let generation = 0
  let disposed = false
  let active: AbortController | undefined
  let cancelTimer: (() => void) | undefined
  let queued = false
  const update = (next: RefreshState) => { state = next; publish(next) }
  const schedule = () => {
    if (disposed) return
    if (active) { queued = true; return }
    cancelTimer ??= start(() => { cancelTimer = undefined; void refresh(false) }, delay)
  }
  const refresh = async (full = true) => {
    if (disposed) return
    cancelTimer?.()
    cancelTimer = undefined
    queued = false
    active?.abort()
    const controller = new AbortController()
    active = controller
    const request = ++generation
    update({ snapshot: state.snapshot, loading: true })
    let cancelTimeout: (() => void) | undefined
    const expired = new Promise<never>((_, reject) => {
      cancelTimeout = start(() => { controller.abort(); reject(new Error("Refresh timed out")) }, timeout)
    })
    try {
      const snapshot = await Promise.race([load(controller.signal, full), expired])
      if (!disposed && request === generation) update({ snapshot, loading: false })
    } catch (error) {
      if (!disposed && request === generation) update({ snapshot: state.snapshot, loading: false, error: errorMessage(error) })
    } finally {
      cancelTimeout?.()
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
      cancelTimer?.()
    },
  }
}
