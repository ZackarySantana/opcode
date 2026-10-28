import { Plugin } from "@opencode/plugin"
import { errorMessage } from "@opcode/core"
import { guarded, type RpcCall } from "@opcode/core/rpc"
import { createFinder, type FindIn } from "./finder"
import { createPool } from "./lsp"
import { TOOL_NAME } from "./message"
import { PLUGIN_ID } from "./review"
import { ReviewRpc } from "./rpc"
import { ReviewRecords } from "./records"
import type { Lookup } from "./references"
import { searchName } from "./search"
import { validLspConfig } from "./servers"
import { replyTool } from "./tools"

/** Records which comments each session was sent, lets its agent reply to them, and serves the replies and symbol lookups to terminals. */
export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const records = new ReviewRecords(ctx.storage)
    await ctx.tool.transform((editor) => editor.add(replyTool(records)))

    // The terminal tags its review messages with the comment IDs they carry.
    await ctx.session.hook("prompt", async (event) => {
      const ids = (event.metadata?.[PLUGIN_ID] as { comments?: unknown } | undefined)?.comments
      if (!Array.isArray(ids) || !ids.length) return
      try { await records.sent(event.sessionID, ids.filter((id): id is string => typeof id === "string")) }
      catch (error) { console.warn(`${PLUGIN_ID}: could not record review comments for session ${event.sessionID}: ${errorMessage(error)}`) }
    })

    // Sessions that never got a review don't spend context on the tool.
    await ctx.session.hook("context", async (event) => {
      const reviewed = await records.get(event.sessionID).then((record) => Array.isArray(record?.comments) && record.comments.length > 0, (error) => {
        // A failing hook would fail the request. Listing the tool is harmless: it rejects unknown comment IDs.
        console.warn(`${PLUGIN_ID}: kept ${TOOL_NAME} for session ${event.sessionID}: ${errorMessage(error)}`)
        return true
      })
      if (!reviewed) delete event.tools[TOOL_NAME]
    })

    // One plugin instance serves one location, so its directory is the root for language servers and searches.
    const pool = createPool()
    const finder = createFinder({ pool, search: searchName })
    const symbolQuery = (find: FindIn) => async (input: unknown, call: RpcCall<"failed">) => {
      const { lookup, lsp } = input as { lookup: Lookup; lsp: unknown }
      // The terminal sends OpenCode's `lsp` config, and its commands run here as language servers. That grants nothing a
      // client lacks: anyone who can call this RPC can already run shell commands through OpenCode's API. Nor does it get
      // around anything beyond that, so the config is only checked for shape (and stripped of variables that load code into
      // every child process), not trusted or sandboxed.
      return await guarded(call, () => find(ctx.location.directory, lookup, lsp === null ? null : validLspConfig(lsp), call.signal))
    }

    const registration = await ctx.rpc.register(ReviewRpc, {
      replies: (input, call) => guarded(call, async () => ({ replies: (await records.get((input as { sessionID: string }).sessionID))?.replies ?? {} })),
      usages: symbolQuery(finder.usages),
      definition: symbolQuery(finder.definition),
    })
    return async () => { await Promise.all([registration.dispose(), pool.dispose()]) }
  },
})
