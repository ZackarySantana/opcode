import { Rpc } from "@opencode/plugin/rpc"
import type { OpenCodeClient } from "@opencode/client"
import type { MessageRecord, RefreshOutput, SearchInput, SearchOutput } from "./domain"
import { MAX_QUERY, MAX_SNIPPET } from "./regex"

export const MAX_BATCH_MESSAGES = 32
export const MAX_MESSAGE_TEXT = 1_048_576
export const MAX_BATCH_BYTES = 2_097_152
const id = { type: "string", minLength: 1, maxLength: 512 } as const
const number = { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const
const messageProperties = {
  id, role: { type: "string", enum: ["user", "assistant"] }, createdAt: number,
  text: { type: "string", maxLength: MAX_MESSAGE_TEXT }, providerID: id, modelID: id,
  cost: number, input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number,
} as const
const resultProperties = {
  id, projectID: id, directory: { type: "string" }, title: { type: "string" }, parentID: id,
  createdAt: number, updatedAt: number, snippet: { type: "string", maxLength: MAX_SNIPPET },
  messageCount: number, providerID: id, modelID: id, modelCount: number,
  cost: number, input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number,
} as const
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false })
/** `missing`: deleted or never existed. `stale`: changed since the caller's revision; retry later. */
const errors = { failed: object({}, []), missing: object({}, []), stale: object({}, []) }
export type SessionErrorType = keyof typeof errors

export const SessionsRpc = Rpc.define({
  id: "opcode-sessions",
  events: {},
  methods: {
    search: {
      errors,
      input: object({ query: { type: "string", maxLength: MAX_QUERY }, projectID: id, showSubagents: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, ["query", "showSubagents"]),
      output: object({
        rows: { type: "array", maxItems: 200, items: object(resultProperties, Object.keys(resultProperties).filter((key) => !["parentID", "providerID", "modelID"].includes(key))) },
        projects: { type: "array", items: object({ id, directory: { type: "string" }, label: { type: "string" } }, ["id", "directory", "label"]) },
        truncated: { type: "boolean" },
      }, ["rows", "projects", "truncated"]),
    },
    refresh: { input: object({}, []), output: object({ sessions: number, deferred: number, failed: number }, ["sessions", "deferred", "failed"]), errors },
    begin: {
      errors,
      input: object({ sessionID: id, updatedAt: number }, ["sessionID", "updatedAt"]),
      // `current`: history at this revision was already imported; no token is issued.
      output: object({ current: { type: "boolean" }, token: id }, ["current"]),
    },
    import: {
      errors,
      input: object({ token: id, messages: { type: "array", minItems: 1, maxItems: MAX_BATCH_MESSAGES, items: object(messageProperties, Object.keys(messageProperties).filter((key) => !["providerID", "modelID"].includes(key))) } }, ["token", "messages"]),
      output: object({ accepted: number }, ["accepted"]),
    },
    finish: { input: object({ token: id, complete: { type: "boolean" } }, ["token"]), output: object({}, []), errors },
  },
})

/** Explicit types at the JSON-Schema boundary; the host validates both directions. */
export interface SessionsRemote {
  search(input: SearchInput, signal?: AbortSignal): Promise<SearchOutput>
  refresh(signal?: AbortSignal): Promise<RefreshOutput>
  begin(input: { sessionID: string; updatedAt: number }, signal?: AbortSignal): Promise<{ current?: boolean; token?: string }>
  import(input: { token: string; messages: MessageRecord[] }, signal?: AbortSignal): Promise<{ accepted: number }>
  /** `complete` records the token's revision as imported; otherwise the token is only released. */
  finish(input: { token: string; complete?: boolean }, signal?: AbortSignal): Promise<void>
}

/** Typed RPC failures arrive as plain `{ type, message }` objects. */
export function sessionErrorType(error: unknown): SessionErrorType | undefined {
  const type = error && typeof error === "object" && "type" in error ? error.type : undefined
  return type === "missing" || type === "stale" || type === "failed" ? type : undefined
}

export function sessionsRemote(client: OpenCodeClient, directory: string): SessionsRemote {
  const rpc = client.rpc(SessionsRpc)
  const options = (signal?: AbortSignal) => ({ location: { directory }, signal })
  return {
    search: async (input, signal) => await rpc.search(input, options(signal)) as SearchOutput,
    refresh: async (signal) => await rpc.refresh({}, options(signal)) as RefreshOutput,
    begin: async (input, signal) => await rpc.begin(input, options(signal)) as { current?: boolean; token?: string },
    import: async (input, signal) => await rpc.import(input, options(signal)) as { accepted: number },
    finish: async (input, signal) => { await rpc.finish(input, options(signal)) },
  }
}

/** Defense in depth for direct callers/tests as well as the schema-validated transport. */
export function validateBatch(messages: MessageRecord[]) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_BATCH_MESSAGES) throw new Error("Invalid history batch size.")
  if (Buffer.byteLength(JSON.stringify(messages), "utf8") > MAX_BATCH_BYTES) throw new Error("History batch exceeds 2 MiB.")
  for (const message of messages) {
    if (!message || typeof message.id !== "string" || !message.id || message.id.length > 512 || !["user", "assistant"].includes(message.role)) throw new Error("Invalid indexed message.")
    if (typeof message.text !== "string" || message.text.length > MAX_MESSAGE_TEXT || Buffer.byteLength(message.text, "utf8") > MAX_MESSAGE_TEXT) throw new Error("History message exceeds 1 MiB of text.")
    for (const key of ["createdAt", "cost", "input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) {
      if (!Number.isFinite(message[key]) || message[key] < 0 || message[key] > Number.MAX_SAFE_INTEGER) throw new Error(`Invalid message ${key}.`)
    }
    for (const key of ["providerID", "modelID"] as const) {
      if (message[key] !== undefined && (typeof message[key] !== "string" || !message[key] || message[key].length > 512)) throw new Error(`Invalid message ${key}.`)
    }
    if (message.role === "user" && (message.providerID || message.modelID || message.cost || message.input || message.output || message.reasoning || message.cacheRead || message.cacheWrite)) throw new Error("User messages cannot supply assistant usage.")
  }
}
