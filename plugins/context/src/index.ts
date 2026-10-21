import { Plugin } from "@opencode/plugin"
import { ContextRpc } from "./rpc"

export default Plugin.define({
  id: "opcode-context",
  async setup(context) {
    await context.rpc.register(ContextRpc, {
      tools: async () => (await context.tool.list()).map(({ id, description }) => ({ id, description })),
    })
  },
})
