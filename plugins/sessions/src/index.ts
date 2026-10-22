import { Plugin } from "@opencode/plugin"
import { isSessionNotFoundError, type OpenCodeEvent } from "@opencode/client"
import { errorMessage } from "@opcode/core"
import { consumeLive, sleep } from "@opcode/core/live"
import { acquireIndex, databasePath } from "./index-store"
import { SessionsRpc, type SessionErrorType } from "./rpc"
import { MissingSessionError, SessionsService, StaleSessionError } from "./service"
import type { MessageRecord, SearchInput } from "./domain"

// A committed revert drops messages from context; resynchronizing prunes them from the index.
const updates = new Set([
  "session.created", "session.renamed", "session.moved", "session.inbox.delivered", "session.text.ended",
  "session.step.ended", "session.step.failed", "session.usage.updated", "session.execution.succeeded",
  "session.execution.failed", "session.execution.interrupted", "session.revert.committed", "session.message.content.updated",
])

const liveWarnings = { stream: "reconnecting event stream", event: "event handling failed", reconnect: "reconnect reconciliation failed" }

/** Consume promptly, coalesce bursts, retry the documented live-only stream after failure. */
export async function watchSessions(
  subscribe: (signal: AbortSignal) => AsyncIterable<OpenCodeEvent>, service: Pick<SessionsService, "syncSession" | "remove" | "refresh">,
  directory: string, signal: AbortSignal, warn: (message: string) => void = console.warn, retryMilliseconds = 1_000,
) {
  const pending = new Map<string, boolean>()
  const attempts = new Map<string, number>()
  // Retries wait per ID, never inside the shared drain loop.
  const retries = new Map<string, ReturnType<typeof setTimeout>>()
  let drain: Promise<void> | undefined
  const queue = (id: string, deleted: boolean) => {
    clearTimeout(retries.get(id))
    retries.delete(id)
    pending.set(id, deleted || pending.get(id) === true)
    startDrain()
  }
  const startDrain = () => {
    if (drain || signal.aborted) return
    drain = (async () => {
      while (pending.size && !signal.aborted) {
        const [id, deleted] = pending.entries().next().value!
        pending.delete(id)
        try { if (deleted) await service.remove(id); else await service.syncSession(id, signal) } catch (error) {
          if (!signal.aborted && !isSessionNotFoundError(error)) {
            // A streaming session changes mid-read: retry quietly; later events also requeue it.
            if (!(error instanceof StaleSessionError)) warn(`opcode-sessions: event indexing failed: ${errorMessage(error)}`)
            const attempt = (attempts.get(id) ?? 0) + 1
            if (attempt < 3) {
              attempts.set(id, attempt)
              if (!pending.has(id)) retries.set(id, setTimeout(() => { retries.delete(id); if (!pending.has(id)) queue(id, deleted) }, retryMilliseconds))
              continue
            }
          }
        }
        attempts.delete(id)
      }
    })().finally(() => { drain = undefined; if (pending.size) startDrain() })
  }
  const enqueue = (id: string, deleted: boolean) => {
    attempts.delete(id)
    queue(id, deleted)
  }
  try {
    await consumeLive({
      signal, subscribe, retryMilliseconds,
      onReconnect: (active) => service.refresh(active, directory),
      handle: (event) => {
        if (!("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
        if (event.type === "session.deleted") return enqueue(event.data.sessionID, true)
        if (!updates.has(event.type)) return
        // Moves must update the old directory even when no destination instance is loaded.
        if (event.type !== "session.moved" && event.location?.directory && event.location.directory !== directory) return
        enqueue(event.data.sessionID, false)
      },
      warn: (error, source) => warn(`opcode-sessions: ${liveWarnings[source]}: ${errorMessage(error)}`),
    })
  } finally {
    await drain
    for (const timer of retries.values()) clearTimeout(timer)
  }
}

export default Plugin.define({
  id: "opcode-sessions",
  async setup(context) {
    const lease = acquireIndex(databasePath(context.options.database))
    const controller = new AbortController()
    const service = new SessionsService(context, lease, controller.signal)
    let registration
    try {
      registration = await context.rpc.register(SessionsRpc, {
        search: async (input, call) => guarded(call, () => service.search(input as SearchInput, call.signal)),
        refresh: async (_input, call) => guarded(call, () => service.refresh(call.signal)),
        begin: async (input, call) => guarded(call, () => service.begin(input as { sessionID: string; updatedAt: number }, call.signal)),
        import: async (input, call) => guarded(call, () => service.import(input as { token: string; messages: MessageRecord[] }, call.signal)),
        finish: async (input, call) => guarded(call, async () => { await service.finish(input as { token: string; complete?: boolean }); return {} }),
      })
    } catch (error) { controller.abort(); lease.release(); throw error }
    const initial = (async () => {
      while (!controller.signal.aborted) {
        try {
          const result = await service.refresh(controller.signal, context.location.directory)
          // Busy sessions are indexed by their live events; failures by reconnects and refresh.
          if (result.failed) console.warn(`opcode-sessions: ${result.failed} sessions could not be indexed; refresh to retry`)
          return
        } catch (error) {
          if (controller.signal.aborted) return
          console.warn(`opcode-sessions: initial indexing failed; retrying: ${errorMessage(error)}`)
          await sleep(5_000, controller.signal)
        }
      }
    })().catch((error) => { if (!controller.signal.aborted) console.warn(`opcode-sessions: initial indexing stopped: ${errorMessage(error)}`) })
    const events = watchSessions((signal) => context.event.subscribe({ signal }), service, context.location.directory, controller.signal)
    return async () => {
      controller.abort()
      try { await registration.dispose() } finally {
        await Promise.allSettled([initial, events])
        await service.settled()
        lease.release()
      }
    }
  },
})

function errorType(error: unknown): SessionErrorType {
  if (error instanceof StaleSessionError) return "stale"
  return error instanceof MissingSessionError || isSessionNotFoundError(error) ? "missing" : "failed"
}

async function guarded<T>(call: { error(type: SessionErrorType, message: string, data: Record<string, never>): unknown }, action: () => Promise<T>): Promise<T> {
  try { return await action() } catch (error) { throw call.error(errorType(error), errorMessage(error), {}) }
}
