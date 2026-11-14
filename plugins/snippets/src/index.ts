import { Plugin, Skill } from "@opencode/plugin"
import { errorMessage } from "@opcode/core"
import { guarded, toJson } from "@opcode/core/rpc"
import { askFirst, MENTION, PLUGIN_ID, type Scope } from "./domain"
import { SnippetsRpc } from "./rpc"
import { SnippetService, type SaveRequest } from "./service"
import { snippetDirectories, SnippetStore } from "./store"
import { snippetTools } from "./tools"

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const store = new SnippetStore(snippetDirectories(ctx.location))
    // Hand edits reach `@` completion without waiting for a prompt that mentions a snippet. Bursts of events, as an
    // editor's save makes, refresh once.
    let pending: ReturnType<typeof setTimeout> | undefined
    const watcher = store.watch(() => {
      clearTimeout(pending)
      pending = setTimeout(() => void service.refresh().catch((error) => console.warn(`${PLUGIN_ID}: could not reread snippets: ${errorMessage(error)}`)), 100)
    })
    const service = new SnippetService(store, { reload: () => ctx.skill.reload(), list: () => ctx.skill.list() }, watcher.arm)
    await ctx.skill.transform((editor) => service.register(editor))
    await service.refresh()
    // `agentTools: false` in the plugin's options keeps the agent from seeing the snippet tools at all.
    const agentTools = ctx.options.agentTools !== false
    if (agentTools) {
      await ctx.tool.transform((editor) => {
        for (const tool of snippetTools({ service, assert: ctx.permission.assert })) editor.add(tool)
      })
      await ctx.agent.transform((editor) => {
        for (const agent of editor.list()) editor.update(agent.id, (info) => askFirst(info.permissions))
      })
    }

    // Only `@` completion makes a mention; pasted or typed `@name` text (as /snippets inserts) is attached here instead.
    // The message keeps its text, and the body is frozen at send time.
    await ctx.session.hook("prompt", async (event) => {
      const { prompt } = event
      if (!prompt.text.match(MENTION)) return
      // A failing hook would reject the prompt; send it without snippets instead.
      const available = await service.refresh().then(() => service.available()).catch((error) => {
        console.warn(`${PLUGIN_ID}: snippets unavailable for this prompt: ${errorMessage(error)}`)
        return new Map()
      })
      // One attachment per snippet, whichever name or alias it was typed with, and never over a file or agent mention.
      const attached = new Set(prompt.skills?.map((skill) => available.get(skill.id)?.path ?? skill.id))
      const mentions = [...prompt.files ?? [], ...prompt.agents ?? [], ...prompt.skills ?? []].flatMap((part) => part.mention ? [part.mention] : [])
      for (const match of prompt.text.matchAll(MENTION)) {
        const snippet = available.get(match[1]!)
        const start = match.index
        const end = start + match[0].length
        if (!snippet || attached.has(snippet.path) || mentions.some((mention) => start < mention.end && mention.start < end)) continue
        attached.add(snippet.path)
        prompt.skills = [...prompt.skills ?? [], { id: Skill.ID.make(match[1]!), mention: { start, end, text: match[0] } }]
      }
    })

    const registration = await ctx.rpc.register(SnippetsRpc, {
      list: async (_input, call) => guarded(call, async () => toJson({ snippets: await service.entries(), agentTools })),
      // The user saves through their own client, so nothing asks; a save over another snippet needs `replace`.
      save: async (input, call) => guarded(call, async () => {
        const save = await service.prepare(input as SaveRequest)
        return toJson({ path: await service.commit(save), breaks: save.breaks })
      }),
      remove: async (input, call) => guarded(call, async () => {
        const { name, scope } = input as { name: string; scope: Scope }
        return { removed: await service.remove(scope, name) }
      }),
    })
    return async () => {
      clearTimeout(pending)
      watcher.close()
      await registration.dispose()
    }
  },
})
