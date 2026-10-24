import type { SessionInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { usageMetrics } from "@opcode/core/usage"
import type { Activity, TimedSession, Usage } from "./domain.js"

type UsageMessage = Pick<SessionMessageAssistant, "id" | "model" | "time" | "cost" | "tokens">

export function isUsageMessage(message: SessionMessageInfo): message is SessionMessageInfo & UsageMessage {
  return message.type === "assistant"
    || (message.type === "compaction" && message.status === "completed" && message.model !== undefined)
}

export function usageFromMessage(message: UsageMessage): Usage {
  return {
    messageID: message.id, providerID: message.model.providerID, modelID: message.model.id, variant: message.model.variant,
    createdAt: message.time.created, completedAt: message.time.completed,
    ...usageMetrics(message),
  }
}

/** History stores a delivered user prompt as a user message and each finished execution as an idle message. */
export function activityFromMessage(message: SessionMessageInfo): Activity | undefined {
  if (message.type === "user") return { kind: "prompt", at: message.time.created }
  if (message.type === "idle") return { kind: "idle", at: message.time.created }
  return undefined
}

/** Only root sessions are timed, so subagent work is not counted twice. */
export function timedSession(session: SessionInfo): TimedSession | undefined {
  if (session.parentID !== undefined) return undefined
  return {
    sessionID: session.id, projectID: session.projectID, directory: session.location.directory,
    title: session.title, createdAt: session.time.created,
  }
}
