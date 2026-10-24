import { Plugin } from "@opencode/plugin"
import { errorMessage } from "@opcode/core"
import { databasePath, LaterDatabase } from "./sqlite"
import { laterTools } from "./tools"

/** Registers the agent's Later tools on the database the terminal reads, resolved the same way on this machine. */
export default Plugin.define({
  id: "opcode-later",
  async setup(ctx) {
    const database = new LaterDatabase(databasePath(ctx.options.database))
    const tools = laterTools(database, ctx.permission.assert)
    await ctx.tool.transform((editor) => { for (const tool of tools) editor.add(tool) })

    // Turning the tools off hides them from sessions created since. Older sessions keep them listed, so their
    // requests keep the prefix the provider cached, and the tools refuse each call instead.
    await ctx.session.hook("context", async (event) => {
      try {
        const disabledAt = database.toolsDisabledAt()
        if (disabledAt === undefined) return
        const session = await ctx.session.get({ sessionID: event.sessionID })
        if (session.time.created >= disabledAt) for (const tool of tools) delete event.tools[tool.name]
      } catch (error) {
        // A failing hook would fail the request. Listing the tools is safe: each call checks the setting again.
        console.warn(`opcode-later: kept the Later tools for session ${event.sessionID}: ${errorMessage(error)}`)
      }
    })
    return () => database.close()
  },
})
