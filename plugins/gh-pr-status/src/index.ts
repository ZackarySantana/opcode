import { errorMessage } from "@opcode/core"
import type { SetTimer } from "@opcode/core/refresh"
import { Plugin } from "@opencode/plugin"
import { formatFeedback } from "./comments"
import { fetchFeedback, runGh, type Runner } from "./gh"
import { PLUGIN_ID, readChange } from "./model"
import { GhPrStatusRpc, type FormattedFeedback } from "./rpc"
import { joinService, PullRequestsService, type Ports } from "./service"

const SETTINGS = "settings"

type Json = Parameters<Plugin.Context["storage"]["set"]>[1]
/** RPC validation and plugin storage take JSON, which has no undefined, while the domain leaves unset fields undefined. */
const asJson = (value: object) => JSON.parse(JSON.stringify(value)) as { [key: string]: Json }

/**
 * Serves the pull requests, settings, and refreshes every terminal shares, from the one service in this server process,
 * and review feedback for the branch in this instance's location. `run` and `timer` serve the service only if this is
 * the first instance in the process to start it.
 */
export function serverPlugin(run: Runner = runGh, timer?: SetTimer) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      // A server option: the server formats the feedback it fetches.
      const prompt = typeof ctx.options.commentsPrompt === "string" ? ctx.options.commentsPrompt : undefined
      // Registered before joining, so the service can announce through this instance as soon as it joins.
      const joined = Promise.withResolvers<PullRequestsService>()
      const ready = joined.promise.then(async (service) => { await service.ready; return service })
      const serve = <T>(call: Call, use: (service: PullRequestsService) => Promise<T> | T) => guarded(call, async () => await use(await ready))
      const registration = await ctx.rpc.register(GhPrStatusRpc, {
        state: (_input, call) => serve(call, (service) => asJson(service.state())),
        update: (input, call) => serve(call, async (service) =>
          asJson(await service.update(readChange(input && typeof input === "object" && "settings" in input ? input.settings : undefined)))),
        refresh: (_input, call) => serve(call, (service) => {
          service.refresh()
          return asJson(service.state())
        }),
        feedback: (_input, call) => guarded(call, async (): Promise<FormattedFeedback> => {
          const feedback = await fetchFeedback(run, call.signal, ctx.location.directory)
          return { number: feedback.pr.number, ...formatFeedback(feedback, prompt) }
        }),
      })
      const ports: Ports = {
        loadSettings: () => ctx.storage.get(SETTINGS),
        saveSettings: (settings) => ctx.storage.set(SETTINGS, asJson(settings)),
        publish: (state) => registration.events.emit("changed", asJson(state)),
      }
      const { service, leave } = joinService(ports, (shared) => new PullRequestsService(shared, run, timer))
      joined.resolve(service)
      return async () => {
        leave()
        await registration.dispose()
      }
    },
  })
}

export default serverPlugin()

type Call = { signal: AbortSignal; error(type: "failed", message: string, data: Record<string, never>): unknown }

/** Declared errors keep handler messages, such as a branch without a pull request, visible to the terminal. */
async function guarded<T>(call: Call, action: () => Promise<T>): Promise<T> {
  try { return await action() } catch (error) { throw call.signal.aborted ? error : call.error("failed", errorMessage(error), {}) }
}
