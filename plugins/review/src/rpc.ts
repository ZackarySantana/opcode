import { Rpc } from "@opencode/plugin/rpc"
import type { OpenCodeClient } from "@opencode/client"
import type { Found, Lookup, LspConfig } from "./references"
import { PLUGIN_ID, replyStatuses, type Reply } from "./review"

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false })
const text = { type: "string" } as const
const count = { type: "integer", minimum: 0 } as const
// Undeclared handler errors reach clients only as a generic rpc.internal failure.
const errors = { failed: object({}, []) }
const reply = object({ status: { type: "string", enum: replyStatuses }, reply: text, at: { type: "number" } }, ["status", "reply", "at"])
const lookup = object({ file: text, line: { type: "integer", minimum: 1 }, column: count, name: { type: "string", minLength: 1 } }, ["file", "line", "column", "name"])
const place = object({ file: text, line: { type: "integer", minimum: 1 }, column: count, text }, ["file", "line", "column", "text"])
/** The merged `lsp` config, or null to search by name only. Its shape is OpenCode's to validate. */
const lsp = { type: ["boolean", "object", "null"] } as const
const found = object({
  engine: { type: "string", enum: ["lsp", "search"] }, server: text, places: { type: "array", items: place }, truncated: { type: "boolean" }, fallback: text, partial: { type: "boolean" },
}, ["engine", "places", "truncated"])
const symbolQuery = { errors, input: object({ lookup, lsp }, ["lookup", "lsp"]), output: found }

export const ReviewRpc = Rpc.define({
  id: PLUGIN_ID,
  events: {},
  methods: {
    replies: { errors, input: object({ sessionID: text }, ["sessionID"]), output: object({ replies: { type: "object", additionalProperties: reply } }, ["replies"]) },
    /** Where the symbol is used, its definition included. */
    usages: symbolQuery,
    /** Where the symbol is defined. */
    definition: symbolQuery,
  },
})

/** The agent's replies to a session's comments, by comment ID, from the server that recorded them. */
export function repliesRemote(client: Pick<OpenCodeClient, "rpc">) {
  const rpc = client.rpc(ReviewRpc)
  return async (sessionID: string, directory: string, signal: AbortSignal): Promise<Record<string, Reply>> =>
    (await rpc.replies({ sessionID }, { location: { directory }, signal }) as { replies: Record<string, Reply> }).replies
}

export type SymbolQuery = (kind: "usages" | "definition", lookup: Lookup, lsp: LspConfig | null, directory: string, signal: AbortSignal) => Promise<Found>

/** Usages and definitions, found by the server where the files are: by a language server when there is one, else by name. */
export function symbolsRemote(client: Pick<OpenCodeClient, "rpc">): SymbolQuery {
  const rpc = client.rpc(ReviewRpc)
  return async (kind, lookup, lsp, directory, signal) => await rpc[kind]({ lookup, lsp }, { location: { directory }, signal }) as Found
}
