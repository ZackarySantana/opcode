import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import type { Usage } from "./domain.js"

type UsageMessage = Pick<SessionMessageAssistant, "id" | "model" | "time" | "cost" | "tokens">

export function isUsageMessage(message: SessionMessageInfo): message is SessionMessageInfo & UsageMessage {
  return message.type === "assistant"
    || (message.type === "compaction" && message.status === "completed" && message.model !== undefined)
}

export function usageFromMessage(message: UsageMessage): Usage {
  return {
    messageID: message.id, providerID: message.model.providerID, modelID: message.model.id,
    createdAt: message.time.created, completedAt: message.time.completed,
    cost: nonnegative(message.cost), input: nonnegative(message.tokens?.input), output: nonnegative(message.tokens?.output),
    reasoning: nonnegative(message.tokens?.reasoning), cacheRead: nonnegative(message.tokens?.cache.read),
    cacheWrite: nonnegative(message.tokens?.cache.write),
  }
}

function nonnegative(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
}
