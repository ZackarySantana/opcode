import { createSerialQueue } from "@opcode/core"
import { joinShared } from "@opcode/core/process"
import { guarded, toJson, type RpcCall } from "@opcode/core/rpc"
import { Plugin } from "@opencode/plugin"
import { fetchText, type Fetcher, type FetchOptions } from "./fetch"
import { PLUGIN_ID, readChange } from "./model"
import { FeedRpc } from "./rpc"
import { FeedsService, joinService, type Ports, type Writes } from "./service"

/** A field of a call's input, which the host checked against the contract. */
const field = (input: unknown, key: string): unknown => input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined

/**
 * Serves the subscriptions, settings, and fetched feeds every terminal shares, from the one service in this server
 * process. `fetcher` and `options` serve the service only if this is the first instance in the process to start it.
 */
export function serverPlugin(fetcher: Fetcher = fetchText, options?: Partial<FetchOptions>) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      // Registered before joining, so the service can announce through this instance as soon as it joins.
      const joined = Promise.withResolvers<FeedsService>()
      const ready = joined.promise.then(async (service) => { await service.ready; return service })
      const serve = <T>(call: RpcCall<"failed">, use: (service: FeedsService) => Promise<T> | T) => guarded(call, async () => await use(await ready))
      const registration = await ctx.rpc.register(FeedRpc, {
        state: (_input, call) => serve(call, (service) => toJson(service.state())),
        update: (input, call) => serve(call, async (service) => toJson(await service.update(readChange(field(input, "settings"))))),
        subscribe: (input, call) => serve(call, async (service) => toJson(await service.subscribe(String(field(input, "url")), field(input, "kind") === "release" ? "release" : "status"))),
        unsubscribe: (input, call) => serve(call, async (service) => toJson(await service.unsubscribe(String(field(input, "url"))))),
        refresh: (_input, call) => serve(call, (service) => {
          service.refresh()
          return toJson(service.state())
        }),
      })
      const ports: Ports = {
        load: (key) => ctx.storage.get(key),
        save: (key, value) => ctx.storage.set(key, value),
        publish: (state) => registration.events.emit("changed", toJson(state)),
      }
      // Keyed without the version: during an upgrade both versions' services change the same storage, one at a time.
      const writes = joinShared<unknown, Writes>(`${PLUGIN_ID}.writes`, ctx, { start: () => createSerialQueue(), stop: () => {} })
      const { service, leave } = joinService(ports, (shared) => new FeedsService(shared, writes.value, fetcher, options))
      joined.resolve(service)
      return async () => {
        leave()
        writes.leave()
        await registration.dispose()
      }
    },
  })
}

export default serverPlugin()
