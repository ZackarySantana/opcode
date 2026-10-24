import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { DELETE_ACTION, scopes, validateSnippet, validName, WRITE_ACTION, type Authoring, type Scope } from "./domain"
import type { SnippetService } from "./service"

export const TOOL_NAMES = ["snippet_list", "snippet_write", "snippet_delete"] as const

export interface ToolDependencies {
  service: Pick<SnippetService, "entries" | "get" | "write" | "remove">
  /** The session's authoring target, or undefined outside an authoring session. */
  authoring: (sessionID: string) => Promise<Authoring | undefined>
  assert: Plugin.Context["permission"]["assert"]
}

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false })
const name = { type: "string", description: "Lowercase kebab-case snippet name, typed as #name or @name." }
const scope = { type: "string", enum: scopes, description: "global applies everywhere; project applies to this project and overrides global." }

/** Snippet tools for authoring sessions. Other sessions never see them, and calls from them fail. */
export function snippetTools({ service, authoring, assert }: ToolDependencies) {
  const guarded = <Input>(run: (input: Input, context: ToolContext, target: Authoring) => Promise<string>) =>
    async (input: unknown, context: ToolContext) => {
      const target = await authoring(context.sessionID)
      if (!target) throw new Error("Snippet tools are only available in a snippet authoring session. Run /snippets new.")
      return { content: await run(input as Input, context, target) }
    }
  const approve = (context: ToolContext, action: string, scope: Scope, name: string, metadata: Record<string, unknown>) => {
    if (!validName(name)) throw new Error(`Invalid snippet name "${name}". Use lowercase letters, digits, and single hyphens, with at least one letter.`)
    return assert({
      sessionID: context.sessionID, agent: context.agent, action,
      resources: [`${scope}/${name}`], save: [`${scope}/${name}`], metadata: { scope, name, ...metadata },
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })
  }
  return [
    {
      name: "snippet_list",
      description: "List every snippet with its scope, body, description, aliases, and whether a project snippet or another skill hides it.",
      input: object({}, []),
      options: { codemode: false },
      execute: guarded(async () => JSON.stringify(await service.entries())),
    },
    {
      name: "snippet_write",
      description: "Create or replace a snippet after the user approves. The body is inserted verbatim.",
      input: object({
        name, scope,
        body: { type: "string", description: "The text to insert. No templating or arguments." },
        description: { type: "string", description: "One line shown in /snippets and @ completion." },
        aliases: { type: "array", items: { type: "string" }, description: "Other names that insert this snippet." },
      }, ["name", "body"]),
      options: { codemode: false },
      execute: guarded<{ name: string; body: string; scope?: Scope; description?: string; aliases?: string[] }>(async (input, context, target) => {
        const existing = await service.get(input.name)
        if (existing && existing.name !== input.name) throw new Error(`${input.name} is an alias of #${existing.name}. Write ${existing.name} instead.`)
        const scope = input.scope ?? existing?.scope ?? target.scope ?? "global"
        // Validate first, so an approval is never spent on a write that would fail.
        const fields = validateSnippet(input.name, { body: input.body, description: input.description, aliases: input.aliases ?? [] })
        await approve(context, WRITE_ACTION, scope, input.name, { ...fields })
        const path = await service.write(scope, input.name, fields)
        return `Saved #${input.name} (${scope}) to ${path}.`
      }),
    },
    {
      name: "snippet_delete",
      description: "Delete a snippet file after the user approves.",
      input: object({ name, scope }, ["name", "scope"]),
      options: { codemode: false },
      execute: guarded<{ name: string; scope: Scope }>(async (input, context) => {
        await approve(context, DELETE_ACTION, input.scope, input.name, {})
        return await service.remove(input.scope, input.name) ? `Deleted #${input.name} (${input.scope}).` : `No ${input.scope} snippet named ${input.name}.`
      }),
    },
  ]
}
