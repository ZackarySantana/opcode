import { Rpc } from "@opencode/plugin/rpc"
import type { OpenCodeClient } from "@opencode/client"
import { describeRpcError, empty, failed, object } from "@opcode/core/rpc"
import { MAX_NAME, PLUGIN_ID, scopes, type Scope } from "./domain"
import type { SnippetEntry } from "./service"

const name = { type: "string", minLength: 1, maxLength: MAX_NAME } as const
const scope = { type: "string", enum: scopes } as const
const text = { type: "string" } as const
const flag = { type: "boolean" } as const
const entry = object(
  { name, scope, path: text, description: text, aliases: { type: "array", items: name }, body: text, overridden: flag, conflict: flag },
  ["name", "scope", "path", "aliases", "body", "overridden", "conflict"],
)

export const SnippetsRpc = Rpc.define({
  id: PLUGIN_ID,
  events: {},
  methods: {
    list: { errors: failed, input: empty, output: object({ snippets: { type: "array", items: entry } }, ["snippets"]) },
    remove: { errors: failed, input: object({ name, scope }, ["name", "scope"]), output: object({ removed: flag }, ["removed"]) },
  },
})

export interface SnippetsRemote {
  list(signal?: AbortSignal): Promise<SnippetEntry[]>
  remove(input: { name: string; scope: Scope }): Promise<boolean>
}

export function snippetsRemote(client: OpenCodeClient, directory: string): SnippetsRemote {
  const rpc = client.rpc(SnippetsRpc)
  const options = (signal?: AbortSignal) => ({ location: { directory }, signal })
  return {
    list: async (signal) => (await rpc.list({}, options(signal)) as { snippets: SnippetEntry[] }).snippets,
    remove: async (input) => (await rpc.remove(input, options()) as { removed: boolean }).removed,
  }
}

export const describeError = (error: unknown) => describeRpcError(error, { name: "Snippets", package: "@lidtop/opencode-snippets" })
