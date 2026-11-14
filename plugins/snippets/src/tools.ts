import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { object } from "@opcode/core/rpc"
import { brokenBy, DELETE_ACTION, effectiveSnippets, expandWrite, referenceProblems, scopes, takenAliases, validateSnippet, validName, WRITE_ACTION, type Authoring, type Scope } from "./domain"
import type { SnippetService } from "./service"

export const TOOL_NAMES = ["snippet_list", "snippet_write", "snippet_delete"] as const

export interface ToolDependencies {
  service: Pick<SnippetService, "entries" | "list" | "blocked" | "write" | "remove">
  /** The session's authoring target, or undefined outside an authoring session. */
  authoring: (sessionID: string) => Promise<Authoring | undefined>
  assert: Plugin.Context["permission"]["assert"]
}

const name = { type: "string", description: "Lowercase kebab-case snippet name, typed as @name." }
const scope = { type: "string", enum: scopes, description: "global applies everywhere; project applies to this project and overrides global." }

/** Snippet tools for authoring sessions. Other sessions never see them, and calls from them fail. */
export function snippetTools({ service, authoring, assert }: ToolDependencies) {
  const guarded = <Input>(run: (input: Input, context: ToolContext, target: Authoring) => Promise<string>) =>
    async (input: unknown, context: ToolContext) => {
      const target = await authoring(context.sessionID)
      if (!target) throw new Error("Snippet tools are only available in a snippet authoring session. Run /snippets new.")
      return { content: await run(input as Input, context, target) }
    }
  const approve = (context: ToolContext, action: string, scope: Scope, name: string, metadata: Record<string, unknown>) =>
    assert({
      sessionID: context.sessionID, agent: context.agent, action,
      resources: [`${scope}/${name}`], save: [`${scope}/${name}`], metadata: { scope, name, ...metadata },
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })
  return [
    {
      name: "snippet_list",
      description: "List every snippet with its scope, body, description, aliases, whether a project snippet or another skill hides it, and why any of its @name references don't expand.",
      input: object({}, []),
      options: { codemode: false },
      execute: guarded(async () => JSON.stringify(await service.entries())),
    },
    {
      name: "snippet_write",
      description: "Create or replace a snippet after the user approves. The body is inserted as written, except that @name on its own between spaces is replaced by that snippet's current text.",
      input: object({
        name, scope,
        body: { type: "string", description: "The text to insert. No templating or arguments; @name on its own uses another snippet." },
        description: { type: "string", description: "One line shown in /snippets and @ completion." },
        aliases: { type: "array", items: { type: "string" }, description: "Other names that insert this snippet." },
      }, ["name", "body"]),
      options: { codemode: false },
      execute: guarded<{ name: string; body: string; scope?: Scope; description?: string; aliases?: string[] }>(async (input, context, target) => {
        const snippets = await service.list()
        const existing = effectiveSnippets(snippets).get(input.name)
        if (existing && existing.name !== input.name) throw new Error(`${input.name} is an alias of @${existing.name}. Write ${existing.name} instead.`)
        const scope = input.scope ?? existing?.scope ?? target.scope ?? "global"
        // Validate first, so an approval is never spent on a write that would fail.
        const fields = validateSnippet(input.name, { body: input.body, description: input.description, aliases: input.aliases ?? [] })
        const taken = takenAliases(snippets, { name: input.name, scope, aliases: fields.aliases })
        if (taken.length) throw new Error(`These aliases would not insert @${input.name}: ${taken.map(([alias, owner]) => `${alias} inserts @${owner.name} (${owner.scope})`).join(", ")}. Drop or rename them.`)
        const expansion = expandWrite(snippets, { name: input.name, scope, ...fields }, await service.blocked())
        const problems = referenceProblems(expansion)
        if (problems.length) {
          const projectOnly = scope === "global" && expansion.missing.some((key) => effectiveSnippets(snippets).get(key)?.scope === "project")
          throw new Error(`@${input.name} would not expand: ${problems.join(" ")}${projectOnly ? " A global snippet can only use global snippets." : ""}`)
        }
        await approve(context, WRITE_ACTION, scope, input.name, { ...fields, ...expansion.text !== fields.body ? { expanded: expansion.text } : {} })
        const path = await service.write(scope, input.name, fields)
        return `Saved @${input.name} (${scope}) to ${path}.`
      }),
    },
    {
      name: "snippet_delete",
      description: "Delete a snippet file after the user approves.",
      input: object({ name, scope }, ["name", "scope"]),
      options: { codemode: false },
      execute: guarded<{ name: string; scope: Scope }>(async (input, context) => {
        if (!validName(input.name)) throw new Error(`Invalid snippet name "${input.name}". Use lowercase letters, digits, and single hyphens, with at least one letter.`)
        // Check first, so an approval is never spent on a delete that does nothing.
        const snippets = await service.list()
        const removed = snippets.find((snippet) => snippet.scope === input.scope && snippet.name === input.name)
        if (!removed) {
          const existing = effectiveSnippets(snippets).get(input.name)
          if (existing && existing.name !== input.name) throw new Error(`${input.name} is an alias of @${existing.name}. Delete ${existing.name} (${existing.scope}) instead.`)
          const other = snippets.find((snippet) => snippet.name === input.name)
          throw new Error(`No ${input.scope} snippet named ${input.name}${other ? `; there is a ${other.scope} one` : ""}.`)
        }
        const broken = brokenBy(snippets, removed, await service.blocked()).map((snippet) => `@${snippet.name}`)
        await approve(context, DELETE_ACTION, input.scope, input.name, broken.length ? { breaks: broken } : {})
        if (!await service.remove(input.scope, input.name)) return `No ${input.scope} snippet named ${input.name}.`
        return `Deleted @${input.name} (${input.scope}).${broken.length ? ` ${broken.join(", ")} used it and now keep its @name as typed. Tell the user.` : ""}`
      }),
    },
  ]
}
