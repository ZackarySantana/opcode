import { errorMessage } from "@opcode/core"
import { consumeLive } from "@opcode/core/live"
import type { SessionInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin"
import { failover, joinShared, packageVersion } from "@opcode/core/process"
import { guarded } from "@opcode/core/rpc"
import { parseActivityBatch, parseImportBatch, parseRange } from "./domain.js"
import { CostLedger, databasePath } from "./ledger.js"
import { createLiveCollector } from "./live.js"
import { timedSession } from "./messages.js"
import { CostRpc } from "./rpc.js"
import { createThrottle } from "./throttle.js"

/** An import sends a session's batches consecutively; reuse its authorization briefly rather than per batch. */
const SESSION_REUSE_MILLISECONDS = 30_000
/** At most one `updated` event per interval, however fast steps or import batches arrive. */
const UPDATE_INTERVAL = 2_000

type Emit = () => Promise<void>

/**
 * The server process's throttle, which every location instance joins with its own emitter: each location writes its
 * own sessions' usage, and clients receive every location's events, so one event per interval serves them all. It
 * emits through the oldest member, and the next one's if that fails.
 */
function joinUpdates(emit: Emit) {
  return joinShared(`opcode-cost.updates@${packageVersion(new URL("../package.json", import.meta.url))}`, emit, {
    start: (members) => createThrottle(() => {
      failover(members, (member) => member()).catch((error: unknown) => console.warn(`opcode-cost: update event failed: ${errorMessage(error)}`))
    }, UPDATE_INTERVAL),
    stop: (throttle) => throttle.dispose(),
  })
}

export default Plugin.define({
  id: "opcode-cost",
  async setup(ctx) {
    // Writes only notify once the RPC is registered; earlier writes have no subscriber to reach.
    let written = () => {}
    const ledger = new CostLedger(databasePath(ctx.options.database), () => written())
    const controller = new AbortController()
    // Host reads run concurrently. Ledger calls are synchronous and follow an abort check, so close()
    // only has to abort, then wait for in-flight work to settle before closing the database.
    const pending = new Set<Promise<unknown>>()
    const run = <T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const combined = AbortSignal.any([signal, controller.signal])
      const task = (async () => {
        combined.throwIfAborted()
        return await work(combined)
      })()
      pending.add(task)
      void task.then(() => pending.delete(task), () => pending.delete(task))
      return task
    }
    let authorized: { session: SessionInfo; at: number } | undefined
    const authorize = async (sessionID: string, signal: AbortSignal) => {
      if (authorized?.session.id === sessionID && Date.now() - authorized.at < SESSION_REUSE_MILLISECONDS) return authorized.session
      const session = await ctx.session.get({ sessionID }, { signal })
      authorized = { session, at: Date.now() }
      return session
    }
    /** Identity and directory come from the connected server, never from an importing terminal. */
    const authorizeImport = async (sessionID: string, signal: AbortSignal) => {
      const session = await authorize(sessionID, signal)
      signal.throwIfAborted()
      if (session.projectID !== ctx.location.project.id) throw new Error("Cannot import a session from another project")
      return session
    }
    const live = createLiveCollector(ctx, ledger)
    let registration: Awaited<ReturnType<typeof ctx.rpc.register<typeof CostRpc>>>
    try {
      registration = await ctx.rpc.register(CostRpc, {
        dashboard: (input, call) => guarded(call, () => run(call.signal, async () => ledger.dashboard(parseRange(input)))),
        time: (input, call) => guarded(call, () => run(call.signal, async () => ledger.time(parseRange(input)))),
        status: (_input, call) => guarded(call, () => run(call.signal, async () => ({
          projectID: ctx.location.project.id, directory: ctx.location.directory,
          lastImport: ledger.lastImport(ctx.location.project.id),
        }))),
        importBatch: (input, call) => guarded(call, () => run(call.signal, async (signal) => {
          const batch = parseImportBatch(input)
          const session = await authorizeImport(batch.sessionID, signal)
          ledger.importBatch(batch.records.map((record) => ({
            ...record, sessionID: session.id, projectID: session.projectID, directory: session.location.directory,
          })))
          return {}
        })),
        importActivity: (input, call) => guarded(call, () => run(call.signal, async (signal) => {
          const batch = parseActivityBatch(input)
          const timed = timedSession(await authorizeImport(batch.sessionID, signal))
          if (timed) ledger.recordActivity(timed, batch.activity)
          return {}
        })),
        completeImport: (_input, call) => guarded(call, () => run(call.signal, async () => {
          authorized = undefined
          ledger.markImported(ctx.location.project.id, ctx.location.directory)
          return {}
        })),
      })
    } catch (error) {
      ledger.close()
      throw error
    }
    const updates = joinUpdates(() => registration.events.emit("updated", {}))
    written = updates.value.notify
    // Public subscriptions are live-only. Reconnect, but never pretend this replays missed usage.
    // consumeLive handles one event at a time, so live writes keep event order.
    const events = consumeLive({
      signal: controller.signal,
      subscribe: (signal) => {
        live.clear()
        return ctx.event.subscribe({ signal })
      },
      handle: (event, signal) => run(signal, (combined) => live.handle(event, combined)),
      warn: (error) => console.warn(`opcode-cost: collection failed: ${errorMessage(error)}`),
    })
    return async () => {
      controller.abort()
      try { await events } finally {
        await Promise.allSettled(pending)
        updates.leave()
        live.clear()
        ledger.close()
      }
    }
  },
})
