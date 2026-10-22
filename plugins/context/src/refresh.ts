import type { OpenCodeEvent } from "@opencode/client"

/** Completed session changes; streaming deltas would otherwise reload history on every chunk. */
const refreshEvents = new Set<OpenCodeEvent["type"]>([
  "session.step.ended", "session.step.failed", "session.tool.success", "session.tool.failed", "session.usage.updated",
  "session.compaction.ended", "session.compaction.failed", "session.shell.ended",
  "session.synthetic", "session.skill.activated", "session.inbox.delivered", "session.agent.selected", "session.model.selected",
  "session.revert.committed", "session.revert.cleared", "session.moved", "session.execution.succeeded",
  "session.execution.failed", "session.execution.interrupted", "session.idle",
])

export function refreshesSnapshot(event: OpenCodeEvent, sessionID?: string) {
  return refreshEvents.has(event.type) && "sessionID" in event.data && event.data.sessionID === sessionID
}
