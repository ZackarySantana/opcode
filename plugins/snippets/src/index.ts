import { Plugin, Skill } from "@opencode/plugin"
import { errorMessage } from "@opcode/core"
import { authoringOf, findTokens, PLUGIN_ID, type Authoring, type Scope } from "./domain"
import { SnippetsRpc } from "./rpc"
import { SnippetService } from "./service"
import { snippetDirectories, SnippetStore } from "./store"
import { snippetTools, TOOL_NAMES } from "./tools"

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const service = new SnippetService(new SnippetStore(snippetDirectories(ctx.location)), {
      reload: () => ctx.skill.reload(),
      list: () => ctx.skill.list(),
    })
    const authoring = async (sessionID: string): Promise<Authoring | undefined> => authoringOf(await ctx.session.get({ sessionID }))
    await ctx.skill.transform((editor) => service.register(editor))
    await service.refresh()
    await ctx.tool.transform((editor) => {
      for (const tool of snippetTools({ service, authoring, assert: ctx.permission.assert })) editor.add(tool)
    })

    // `#name` becomes a skill attachment: the message keeps its text, and the body is frozen at send time.
    await ctx.session.hook("prompt", async (event) => {
      if (!event.prompt.text.includes("#") && !event.prompt.skills?.length) return
      // A failing hook would reject the prompt; send it without snippets instead.
      const available = await service.refresh().then(() => service.available()).catch((error) => {
        console.warn(`${PLUGIN_ID}: snippets unavailable for this prompt: ${errorMessage(error)}`)
        return new Map()
      })
      // One attachment per snippet, whichever name or alias it was typed with.
      const attached = new Set(event.prompt.skills?.map((skill) => available.get(skill.id)?.path ?? skill.id))
      const tokens = findTokens(event.prompt.text, (name) => {
        const path = available.get(name)?.path
        if (!path || attached.has(path)) return false
        attached.add(path)
        return true
      })
      if (!tokens.length) return
      event.prompt.skills = [...event.prompt.skills ?? [], ...tokens.map((token) => ({
        id: Skill.ID.make(token.name),
        mention: { start: token.start, end: token.end, text: `#${token.name}` },
      }))]
    })

    await ctx.session.hook("context", async (event) => {
      const target = await authoring(event.sessionID).catch((error) => {
        console.warn(`${PLUGIN_ID}: could not read session ${event.sessionID}: ${errorMessage(error)}`)
        return undefined
      })
      if (!target) for (const name of TOOL_NAMES) delete event.tools[name]
    })

    const registration = await ctx.rpc.register(SnippetsRpc, {
      list: async (_input, call) => guarded(call, async () => ({ snippets: await service.entries() })),
      remove: async (input, call) => guarded(call, async () => {
        const { name, scope } = input as { name: string; scope: Scope }
        return { removed: await service.remove(scope, name) }
      }),
    })
    return () => registration.dispose()
  },
})

async function guarded<T>(call: { error(type: "failed", message: string, data: Record<string, never>): unknown }, action: () => Promise<T>): Promise<T> {
  try { return await action() } catch (error) { throw call.error("failed", errorMessage(error), {}) }
}
