import { errorMessage } from "@opcode/core"
import type { SetTimer } from "@opcode/core/refresh"
import { guarded, toJson, type RpcCall } from "@opcode/core/rpc"
import { Plugin } from "@opencode/plugin"
import { PLUGIN_ID, type LaterItem, type Settings } from "./domain"
import { LaterRpc } from "./rpc"
import { joinService, type Ports } from "./service"
import { laterTools } from "./tools"

/** The whole list in one document: see `LaterList`. */
const LIST = "list"

/**
 * Serves the Later list every terminal shows and the agent's tools change, from the one service in this server process.
 * `timer` serves the service only if this is the first instance in the process to start it.
 */
export function serverPlugin(timer?: SetTimer) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      // Registered before joining, so the service can announce through this instance as soon as it joins.
      const joined = Promise.withResolvers<ReturnType<typeof joinService>["service"]>()
      const serve = <T extends object>(call: RpcCall<"failed">, use: (service: Awaited<typeof joined.promise>) => Promise<T>) =>
        guarded(call, async () => toJson(await use(await joined.promise)))
      // The host checks inputs against LaterRpc's schemas before calling.
      type Input = { item: LaterItem; message: string; id: string; offset: -1 | 1; settings: Partial<Settings> }
      const read = (input: unknown) => input as Input
      const registration = await ctx.rpc.register(LaterRpc, {
        state: (_input, call) => serve(call, (service) => service.state()),
        add: (input, call) => serve(call, (service) => service.add(read(input).message)),
        edit: (input, call) => serve(call, (service) => service.edit(read(input).item, read(input).message)),
        complete: (input, call) => serve(call, (service) => service.complete(read(input).item)),
        restore: (input, call) => serve(call, (service) => service.restore(read(input).item)),
        delete: (input, call) => serve(call, (service) => service.delete(read(input).item)),
        move: (input, call) => serve(call, (service) => service.move(read(input).id, read(input).offset)),
        settings: (input, call) => serve(call, (service) => service.updateSettings(read(input).settings)),
      })
      const ports: Ports = {
        load: () => ctx.storage.get(LIST),
        save: (list) => ctx.storage.set(LIST, toJson(list)),
        publish: (state) => registration.events.emit("changed", toJson(state)),
      }
      const { service, leave } = joinService(ports, timer)
      joined.resolve(service)
      const stop = async () => {
        leave()
        await registration.dispose()
      }

      try {
        const tools = laterTools(service, ctx.permission.assert)
        await ctx.tool.transform((editor) => { for (const tool of tools) editor.add(tool) })
        // Turning the tools off hides them from sessions created since. Older sessions keep them listed, so their
        // requests keep the prefix the provider cached, and the tools refuse each call instead.
        await ctx.session.hook("context", async (event) => {
          try {
            const disabledAt = await service.toolsDisabledAt()
            if (disabledAt === undefined) return
            const session = await ctx.session.get({ sessionID: event.sessionID })
            if (session.time.created >= disabledAt) for (const tool of tools) delete event.tools[tool.name]
          } catch (error) {
            // A failing hook would fail the request. Listing the tools is safe: each call checks the setting again.
            console.warn(`${PLUGIN_ID}: kept the Later tools for session ${event.sessionID}: ${errorMessage(error)}`)
          }
        })
      } catch (error) {
        await stop()
        throw error
      }
      return stop
    },
  })
}

export default serverPlugin()
