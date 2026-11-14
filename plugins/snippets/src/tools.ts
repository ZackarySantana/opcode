import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { object } from "@opcode/core/rpc"
import { DELETE_ACTION, effectiveSnippets, scopes, validName, WRITE_ACTION, type Scope } from "./domain"
import type { SnippetService } from "./service"

export const TOOL_NAMES = ["snippet_list", "snippet_read", "snippet_write", "snippet_delete"] as const

export interface ToolDependencies {
  service: Pick<SnippetService, "entries" | "list" | "prepare" | "commit" | "prepareRemove" | "remove">
  assert: Plugin.Context["permission"]["assert"]
}

const name = { type: "string", description: "Lowercase kebab-case snippet name, typed as @name." }
const scope = { type: "string", enum: scopes, description: "global applies everywhere; project applies to this project and overrides a global snippet with the same name." }
const ONLY_WHEN_ASKED = "Use only when the user asks about their snippets: reusable prompt text they insert into a message by typing @name."

/** Snippet tools for every session. Writes and deletes wait for the user's approval. */
export function snippetTools({ service, assert }: ToolDependencies) {
  const approve = (context: ToolContext, action: string, scope: Scope, name: string, metadata: Record<string, unknown>) =>
    assert({
      sessionID: context.sessionID, agent: context.agent, action,
      resources: [`${scope}/${name}`], save: [`${scope}/${name}`], metadata: { scope, name, ...metadata },
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })
  const run = <Input>(execute: (input: Input, context: ToolContext) => Promise<string>) =>
    async (input: unknown, context: ToolContext) => ({ content: await execute(input as Input, context) })
  return [
    {
      name: "snippet_list",
      description: `List snippets: name, scope, description, aliases, whether a project snippet or another skill hides one, and why any of its @name references don't expand. Read one with snippet_read. ${ONLY_WHEN_ASKED}`,
      input: object({}, []),
      options: { codemode: false },
      execute: run(async () => JSON.stringify((await service.entries()).map(({ name, scope, description, aliases, overridden, conflict, problems }) =>
        ({ name, scope, ...description ? { description } : {}, aliases, overridden, conflict, problems })))),
    },
    {
      name: "snippet_read",
      description: `Read a snippet's text, and the text it inserts with its @name references expanded. ${ONLY_WHEN_ASKED}`,
      input: object({ name, scope: { ...scope, description: "Omit for the snippet @name inserts here." } }, ["name"]),
      options: { codemode: false },
      execute: run<{ name: string; scope?: Scope }>(async (input) => {
        const entries = await service.entries()
        const entry = input.scope
          ? entries.find((other) => other.scope === input.scope && other.name === input.name)
          : effectiveSnippets(entries).get(input.name)
        if (!entry) throw new Error(`No ${input.scope ? `${input.scope} ` : ""}snippet named ${input.name}.`)
        const { path, overridden, conflict, breaks, ...rest } = entry
        return JSON.stringify({ ...rest, path, overridden, conflict, usedBy: breaks })
      }),
    },
    {
      name: "snippet_write",
      description: [
        "Create, replace, rename, or move a snippet after the user approves.",
        "Save exactly the text the user wants reused, such as a prompt or handoff from this conversation, written so it works on its own in a later session.",
        "The body is inserted as written: there is no templating or arguments, but @name on its own between spaces is replaced by that snippet's current text.",
        "Every @name in a body must be a snippet, with no loops; a global snippet can only use global ones.",
        "Unless the user said otherwise, pick a short name and the global scope, and tell them both after saving.",
        ONLY_WHEN_ASKED,
      ].join(" "),
      input: object({
        name, scope,
        body: { type: "string", description: "The text to insert." },
        description: { type: "string", description: "One line shown in /snippets and @ completion." },
        aliases: { type: "array", items: { type: "string" }, description: "Other names that insert this snippet." },
        from: { ...object({ name, scope }, ["name", "scope"]), description: "The existing snippet to rename or move to name and scope. Omit to create or replace." },
      }, ["name", "body"]),
      options: { codemode: false },
      execute: run<{ name: string; body: string; scope?: Scope; description?: string; aliases?: string[]; from?: { name: string; scope: Scope } }>(async (input, context) => {
        const snippets = await service.list()
        const existing = effectiveSnippets(snippets).get(input.name)
        const scope = input.scope ?? (existing?.name === input.name ? existing.scope : undefined) ?? input.from?.scope ?? "global"
        const save = await service.prepare({
          name: input.name, scope, from: input.from, replace: true,
          fields: { body: input.body, description: input.description, aliases: input.aliases ?? [] },
        })
        await approve(context, WRITE_ACTION, scope, input.name, {
          ...save.fields, ...save.from ? { from: `${save.from.scope}/${save.from.name}` } : {},
          ...save.expanded !== save.fields.body ? { expanded: save.expanded } : {}, ...save.breaks.length ? { breaks: save.breaks } : {},
        })
        const path = await service.commit(save)
        const moved = save.from && (save.from.name !== save.name || save.from.scope !== save.scope) ? ` It replaces @${save.from.name} (${save.from.scope}).` : ""
        return `Saved @${save.name} (${scope}) to ${path}.${moved}${brokenNote(save.breaks, save.from?.name)}`
      }),
    },
    {
      name: "snippet_delete",
      description: `Delete a snippet file after the user approves. ${ONLY_WHEN_ASKED}`,
      input: object({ name, scope }, ["name", "scope"]),
      options: { codemode: false },
      execute: run<{ name: string; scope: Scope }>(async (input, context) => {
        if (!validName(input.name)) throw new Error(`Invalid snippet name "${input.name}". Use lowercase letters, digits, and single hyphens, with at least one letter.`)
        // Checked first, so an approval is never spent on a delete that does nothing.
        const { breaks } = await service.prepareRemove(input)
        await approve(context, DELETE_ACTION, input.scope, input.name, breaks.length ? { breaks } : {})
        if (!await service.remove(input.scope, input.name)) return `No ${input.scope} snippet named ${input.name}.`
        return `Deleted @${input.name} (${input.scope}).${brokenNote(breaks, input.name)}`
      }),
    },
  ]
}

const brokenNote = (breaks: readonly string[], name?: string) =>
  breaks.length ? ` ${breaks.map((other) => `@${other}`).join(", ")} used ${name ? `@${name}` : "it"} and now keep that @name as typed. Tell the user.` : ""
