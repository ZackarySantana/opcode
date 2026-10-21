import type { SessionInfo, SessionMessageAssistant, SessionMessageUser } from "@opencode/client"
import { messageRecord, sessionRecord } from "../src/domain"
import type { SessionsRemote } from "../src/rpc"

export function session(id = "s1", directory = "/work/alpha", updated = 100): SessionInfo {
  return { id, projectID: "p1", title: `Session ${id}`, location: { directory }, time: { created: 1, updated }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
}
export function user(id = "m1", text = "Historical JWT refresh"): SessionMessageUser {
  return { id, type: "user", text, time: { created: 2 } }
}
export function assistant(id = "m2", text = "JWT rotation completed"): SessionMessageAssistant {
  return { id, type: "assistant", agent: "build", time: { created: 3, completed: 4 }, model: { providerID: "openai", id: "test-model" },
    content: [{ type: "text", text }], cost: 0.25, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } } }
}
export const record = (id = "s1", updated = 100) => sessionRecord(session(id, "/work/alpha", updated))
export const message = (id = "m1", text = "Historical JWT refresh") => messageRecord(user(id, text))!
export function remoteStub(overrides: Partial<SessionsRemote> = {}): SessionsRemote {
  return {
    search: async () => ({ rows: [], projects: [] }), refresh: async () => ({ sessions: 0 }),
    begin: async () => ({ token: "token" }), import: async (input) => ({ accepted: input.messages.length }), finish: async () => {},
    ...overrides,
  }
}
