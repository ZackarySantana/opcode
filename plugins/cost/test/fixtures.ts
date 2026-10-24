import type { OpenCodeEvent, SessionInfo, SessionMessageAssistant } from "@opencode/client"
import type { CostService } from "../src/client.js"
import type { UsageRecord } from "../src/domain.js"
import type { CostLedger } from "../src/ledger.js"
import { timedSession } from "../src/messages.js"

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

/** The server handlers' ledger effects, without RPC. */
export function serviceFor(ledger: CostLedger, sessions = [session]): CostService {
  return {
    dashboard: async (filter) => ledger.dashboard(filter),
    time: async (filter) => ledger.time(filter),
    status: async () => ({ projectID: context.projectID, directory: context.directory, lastImport: ledger.lastImport(context.projectID) }),
    importBatch: async (batch) => {
      const actual = sessions.find((item) => item.id === batch.sessionID)!
      ledger.importBatch(batch.records.map((record) => ({ ...record, sessionID: actual.id, projectID: actual.projectID, directory: actual.location.directory })))
    },
    importActivity: async (batch) => {
      const actual = sessions.find((item) => item.id === batch.sessionID)!
      const timed = timedSession(actual)
      if (timed) ledger.recordActivity(timed, batch.activity)
    },
    completeImport: async () => { ledger.markImported(context.projectID, context.directory) },
  }
}
