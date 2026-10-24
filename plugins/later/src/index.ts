import { Plugin } from "@opencode/plugin"
import { databasePath, LaterDatabase } from "./sqlite"
import { laterTools } from "./tools"

/** Registers the agent's Later tools on the database the terminal reads, resolved the same way on this machine. */
export default Plugin.define({
  id: "opcode-later",
  async setup(ctx) {
    const database = new LaterDatabase(databasePath(ctx.options.database))
    await ctx.tool.transform((editor) => { for (const tool of laterTools(database, ctx.permission.assert)) editor.add(tool) })
    return () => database.close()
  },
})
