import type { SetTimer } from "@opcode/core/refresh"
import { guarded, toJson, type RpcCall } from "@opcode/core/rpc"
import { Plugin } from "@opencode/plugin"
import { formatFeedback } from "./comments"
import { fetchFeedback, runGh, type Runner } from "./gh"
import { PLUGIN_ID, readChange } from "./model"
import { GhPrStatusRpc, type FormattedFeedback } from "./rpc"
import { joinService, PullRequestsService, type Ports } from "./service"

const SETTINGS = "settings"

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
      const serve = <T>(call: RpcCall<"failed">, use: (service: PullRequestsService) => Promise<T> | T) => guarded(call, async () => await use(await ready))
      const registration = await ctx.rpc.register(GhPrStatusRpc, {
        state: (_input, call) => serve(call, (service) => toJson(service.state())),
        update: (input, call) => serve(call, async (service) =>
          toJson(await service.update(readChange(input && typeof input === "object" && "settings" in input ? input.settings : undefined)))),
        refresh: (_input, call) => serve(call, (service) => {
          service.refresh()
          return toJson(service.state())
        }),
        feedback: (_input, call) => guarded(call, async (): Promise<FormattedFeedback> => {
          const feedback = await fetchFeedback(run, call.signal, ctx.location.directory)
          return { number: feedback.pr.number, ...formatFeedback(feedback, prompt) }
        }),
      })
      const ports: Ports = {
        loadSettings: () => ctx.storage.get(SETTINGS),
        saveSettings: (settings) => ctx.storage.set(SETTINGS, toJson(settings)),
        publish: (state) => registration.events.emit("changed", toJson(state)),
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
