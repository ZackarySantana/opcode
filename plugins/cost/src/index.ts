import { createSerialQueue, errorMessage } from "@opcode/core"
import { Plugin } from "@opencode/plugin"
import { parseFilter, parseImportBatch } from "./domain.js"
import { CostLedger, databasePath } from "./ledger.js"
import { consumeEvents, createLiveCollector } from "./live.js"
import { CostRpc } from "./rpc.js"

export default Plugin.define({
  id: "opcode-cost",
  async setup(ctx) {
    const ledger = new CostLedger(databasePath(ctx.options.database))
    const controller = new AbortController()
    const queue = createSerialQueue()
    const run = <T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> => queue(async () => {
      const combined = AbortSignal.any([signal, controller.signal])
      combined.throwIfAborted()
      return work(combined)
    })
    const live = createLiveCollector(ctx, ledger)
    try {
      await ctx.rpc.register(CostRpc, {
        dashboard: (input, call) => run(call.signal, async () => ledger.dashboard(parseFilter(input))),
        status: (_input, call) => run(call.signal, async () => ({
          projectID: ctx.location.project.id, directory: ctx.location.directory,
          lastImport: ledger.lastImport(ctx.location.project.id),
        })),
        importBatch: (input, call) => run(call.signal, async (signal) => {
          const batch = parseImportBatch(input)
          // Identity and directory come from the connected server, never from an importing terminal.
          const session = await ctx.session.get({ sessionID: batch.sessionID }, { signal })
          signal.throwIfAborted()
          if (session.projectID !== ctx.location.project.id) throw new Error("Cannot import a session from another project")
          ledger.importBatch(batch.records.map((record) => ({
            ...record, sessionID: session.id, projectID: session.projectID, directory: session.location.directory,
          })))
          return {}
        }),
        completeImport: (_input, call) => run(call.signal, async () => {
          ledger.markImported(ctx.location.project.id, ctx.location.directory)
          return {}
        }),
      })
    } catch (error) {
      ledger.close()
      throw error
    }
    const events = consumeEvents({
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
      await events
      await queue(async () => { live.clear(); ledger.close() })
    }
  },
})
