import { errorMessage } from "@opcode/core"
import type { SetTimer } from "@opcode/core/refresh"
import { Plugin } from "@opencode/plugin"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { formatFeedback } from "./comments"
import { fetchFeedback, runGh, type Runner } from "./gh"
import type { SettingsChange } from "./model"
import { GhPrStatusRpc, PLUGIN_ID, type FormattedFeedback } from "./rpc"
import { joinService, type Member } from "./service"

/**
 * Serves the pull requests, settings, and refreshes every terminal shares, from the one service in this server process,
 * and review feedback for the branch in this instance's location.
 */
export function serverPlugin(run: Runner = runGh, timer?: SetTimer) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      // A server option: the server formats the feedback it fetches.
      const prompt = typeof ctx.options.commentsPrompt === "string" ? ctx.options.commentsPrompt : undefined
      let registration: RpcRegistration<typeof GhPrStatusRpc> | undefined
      const member: Member = {
        storage: ctx.storage,
        async publish(state) {
          if (!registration) throw new Error("Not registered yet")
          await registration.events.emit("changed", { ...state })
        },
      }
      const { service, leave } = joinService(member, run, timer)
      try {
        registration = await ctx.rpc.register(GhPrStatusRpc, {
          state: (_input, call) => guarded(call, async () => { await service.ready; return service.state() }),
          update: (input, call) => guarded(call, async () => {
            await service.ready
            return await service.update((input as { settings: SettingsChange }).settings)
          }),
          refresh: (_input, call) => guarded(call, async () => {
            await service.ready
            service.refresh()
            return service.state()
          }),
          feedback: (_input, call) => guarded(call, async (): Promise<FormattedFeedback> => {
            const feedback = await fetchFeedback(run, call.signal, ctx.location.directory)
            return { number: feedback.pr.number, ...formatFeedback(feedback, prompt) }
          }),
        })
      } catch (error) {
        leave()
        throw error
      }
      return async () => {
        leave()
        await registration?.dispose()
      }
    },
  })
}

export default serverPlugin()

/** Declared errors keep handler messages, such as a branch without a pull request, visible to the terminal. */
async function guarded<T>(call: { signal: AbortSignal; error(type: "failed", message: string, data: Record<string, never>): unknown }, action: () => Promise<T>): Promise<T> {
  try { return await action() } catch (error) { throw call.signal.aborted ? error : call.error("failed", errorMessage(error), {}) }
}
