import { Rpc } from "@opencode/plugin/rpc"
import type { OpenCodeClient } from "@opencode/client"
import { describeRpcError, empty, failed, object } from "@opcode/core/rpc"
import { MAX_NAME, PLUGIN_ID, scopes, type Scope, type SnippetFields } from "./domain"
import type { SnippetEntry, SnippetKey } from "./service"

const name = { type: "string", minLength: 1, maxLength: MAX_NAME } as const
const scope = { type: "string", enum: scopes } as const
const text = { type: "string" } as const
const flag = { type: "boolean" } as const
const names = { type: "array", items: name } as const
const texts = { type: "array", items: text } as const
const key = object({ name, scope }, ["name", "scope"])
const entry = object(
  { name, scope, path: text, description: text, aliases: names, body: text, overridden: flag, conflict: flag, expanded: text, problems: texts, breaks: names },
  ["name", "scope", "path", "aliases", "body", "overridden", "conflict", "expanded", "problems", "breaks"],
)
const fields = object({ description: text, aliases: names, body: text }, ["aliases", "body"])

export const SnippetsRpc = Rpc.define({
  id: PLUGIN_ID,
  events: {},
  methods: {
    list: { errors: failed, input: empty, output: object({ snippets: { type: "array", items: entry }, agentTools: flag }, ["snippets", "agentTools"]) },
    save: {
      errors: failed,
      input: object({ name, scope, fields, from: key, replace: flag }, ["name", "scope", "fields"]),
      output: object({ path: text, breaks: names }, ["path", "breaks"]),
    },
    remove: { errors: failed, input: key, output: object({ removed: flag }, ["removed"]) },
  },
})

export interface SnippetList {
  snippets: SnippetEntry[]
  /** Whether the agent has the snippet tools, so `/snippets save` can ask it. */
  agentTools: boolean
}

export interface SnippetsRemote {
  list(signal?: AbortSignal): Promise<SnippetList>
  /** Creates a snippet, or with `from` replaces that one, renaming or moving it. Fails rather than replace another. */
  save(input: SnippetKey & { fields: SnippetFields; from?: SnippetKey }): Promise<{ path: string; breaks: string[] }>
  remove(input: { name: string; scope: Scope }): Promise<boolean>
}

export function snippetsRemote(client: OpenCodeClient, directory: string): SnippetsRemote {
  const rpc = client.rpc(SnippetsRpc)
  const options = (signal?: AbortSignal) => ({ location: { directory }, signal })
  return {
    list: async (signal) => await rpc.list({}, options(signal)) as SnippetList,
    save: async (input) => await rpc.save(input, options()) as { path: string; breaks: string[] },
    remove: async (input) => (await rpc.remove(input, options()) as { removed: boolean }).removed,
  }
}

export const describeError = (error: unknown) => describeRpcError(error, { name: "Snippets", package: "@lidtop/opencode-snippets" })
