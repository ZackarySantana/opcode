import type { SetTimer } from "@opcode/core/refresh"
import { guarded, toJson, type RpcCall } from "@opcode/core/rpc"
import { Plugin } from "@opencode/plugin"
import { runGh, type Runner } from "./gh"
import { PLUGIN_ID, readChange } from "./model"
import { GhPrStatusRpc } from "./rpc"
import { joinService, PullRequestsService, type Ports } from "./service"

const SETTINGS = "settings"

/**
 * Serves the pull requests, settings, and refreshes every terminal shares, from the one service in this server process.
 * `run` and `timer` serve the service only if this is the first instance in the process to start it.
 */
export function serverPlugin(run: Runner = runGh, timer?: SetTimer) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
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
