import { Plugin } from "@opencode/plugin"
import { OpenRouter } from "./openrouter"
import { mediaTools } from "./tools"

/**
 * Media generation tools on the OpenRouter key saved with /connect (or OPENROUTER_API_KEY). The key is an
 * integration credential, so it works even when a policy keeps OpenRouter out of model selection.
 */
export default Plugin.define({
  id: "opcode-media",
  async setup(ctx) {
    const openrouter = new OpenRouter(async () => {
      const connection = await ctx.integration.connection.active("openrouter")
      const credential = connection && await ctx.integration.connection.resolve(connection)
      if (credential?.type === "key") return credential.key
      throw new Error("OpenRouter isn't connected. Ask the user to run /connect, choose OpenRouter, and enter an API key.")
    })
    await ctx.tool.transform((editor) => {
      for (const tool of mediaTools({ openrouter, directory: ctx.location.directory, assert: ctx.permission.assert })) editor.add(tool)
    })
  },
})
