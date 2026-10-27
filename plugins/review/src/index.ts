import { Plugin } from "@opencode/plugin"
import { errorMessage } from "@opcode/core"
import { TOOL_NAME } from "./message"
import { PLUGIN_ID } from "./review"
import { ReviewRpc } from "./rpc"
import { ReviewRecords } from "./records"
import { replyTool } from "./tools"

/** Records which comments each session was sent, lets its agent reply to them, and serves the replies to terminals. */
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

    const registration = await ctx.rpc.register(ReviewRpc, {
      replies: async (input, call) => {
        try { return { replies: (await records.get((input as { sessionID: string }).sessionID))?.replies ?? {} } }
        catch (error) { throw call.error("failed", errorMessage(error), {}) }
      },
    })
    return () => registration.dispose()
  },
})
