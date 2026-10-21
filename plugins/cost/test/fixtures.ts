import type { OpenCodeEvent, SessionInfo, SessionMessageAssistant } from "@opencode/client"
import type { UsageRecord } from "../src/domain.js"

export const context = { sessionID: "session", projectID: "project", directory: "/work/main" }
export const tokens = { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }
export const record: UsageRecord = {
  ...context, messageID: "message", providerID: "provider", modelID: "model",
  createdAt: new Date(2026, 6, 10, 12).getTime(), completedAt: new Date(2026, 6, 10, 12, 1).getTime(),
  cost: 0.5, input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5,
}
export const session: SessionInfo = {
  id: context.sessionID, projectID: context.projectID, location: { directory: context.directory },
  cost: 0.5, tokens, time: { created: 1, updated: 2 },
}
export const message: SessionMessageAssistant = {
  id: record.messageID, type: "assistant", agent: "build", content: [],
  model: { id: record.modelID, providerID: record.providerID },
  time: { created: record.createdAt, completed: record.completedAt }, cost: record.cost, tokens,
}
export const location = {
  directory: context.directory,
  project: { id: context.projectID, directory: context.directory, canonical: context.directory },
}

/** Fixtures omit irrelevant durable event-envelope fields, not usage fields. */
export function event(type: string, data: unknown, options: { created?: number; directory?: string | null } = {}): OpenCodeEvent {
  return {
    id: "event", type, data, created: options.created ?? record.completedAt!,
    location: options.directory === null ? undefined : { directory: options.directory ?? context.directory },
  } as OpenCodeEvent
}
