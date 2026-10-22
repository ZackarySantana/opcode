import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { usageMetrics } from "@opcode/core/usage"
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
    ...usageMetrics(message),
  }
}
