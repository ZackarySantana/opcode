import { Rpc } from "@opencode/plugin/rpc"
import type { OpenCodeClient } from "@opencode/client"
import type { MessageRecord, SearchInput, SearchOutput } from "./domain"

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
  createdAt: number, updatedAt: number, snippet: { type: "string", maxLength: 4096 },
  messageCount: number, providerID: id, modelID: id, modelCount: number,
  cost: number, input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number,
} as const
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false })
const errors = { failed: object({}, []) }

export const SessionsRpc = Rpc.define({
  id: "opcode-sessions",
  events: {},
  methods: {
    search: {
      errors,
      input: object({ query: { type: "string", maxLength: 256 }, projectID: id, showSubagents: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, ["query", "showSubagents"]),
      output: object({
        rows: { type: "array", maxItems: 200, items: object(resultProperties, Object.keys(resultProperties).filter((key) => !["parentID", "providerID", "modelID"].includes(key))) },
        projects: { type: "array", items: object({ id, directory: { type: "string" }, label: { type: "string" } }, ["id", "directory", "label"]) },
      }, ["rows", "projects"]),
    },
    refresh: { input: object({}, []), output: object({ sessions: number }, ["sessions"]), errors },
    begin: {
      errors,
      input: object({ sessionID: id, updatedAt: number }, ["sessionID", "updatedAt"]),
      output: object({ token: id }, ["token"]),
    },
    import: {
      errors,
      input: object({ token: id, messages: { type: "array", minItems: 1, maxItems: MAX_BATCH_MESSAGES, items: object(messageProperties, Object.keys(messageProperties).filter((key) => !["providerID", "modelID"].includes(key))) } }, ["token", "messages"]),
      output: object({ accepted: number }, ["accepted"]),
    },
    finish: { input: object({ token: id }, ["token"]), output: object({}, []), errors },
  },
})

/** Explicit types at the JSON-Schema boundary; the host validates both directions. */
export interface SessionsRemote {
  search(input: SearchInput, signal?: AbortSignal): Promise<SearchOutput>
  refresh(signal?: AbortSignal): Promise<{ sessions: number }>
  begin(input: { sessionID: string; updatedAt: number }, signal?: AbortSignal): Promise<{ token: string }>
  import(input: { token: string; messages: MessageRecord[] }, signal?: AbortSignal): Promise<{ accepted: number }>
  finish(token: string, signal?: AbortSignal): Promise<void>
}

export function sessionsRemote(client: OpenCodeClient, directory: string): SessionsRemote {
  const rpc = client.rpc(SessionsRpc)
  const options = (signal?: AbortSignal) => ({ location: { directory }, signal })
  return {
    search: async (input, signal) => await rpc.search(input, options(signal)) as SearchOutput,
    refresh: async (signal) => await rpc.refresh({}, options(signal)) as { sessions: number },
    begin: async (input, signal) => await rpc.begin(input, options(signal)) as { token: string },
    import: async (input, signal) => await rpc.import(input, options(signal)) as { accepted: number },
    finish: async (token, signal) => { await rpc.finish({ token }, options(signal)) },
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
