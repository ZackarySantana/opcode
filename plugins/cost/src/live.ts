import type { OpenCodeEvent, SessionMessageAssistant } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { isUsageMessage, usageFromMessage } from "./messages.js"
import type { CostLedger } from "./ledger.js"

type Host = { location: { directory: string }; session: Pick<Plugin.Context["session"], "get" | "context"> }

export function createLiveCollector(host: Host, ledger: CostLedger) {
  const started = new Map<string, SessionMessageAssistant>()
  return {
    clear: () => started.clear(),
    async handle(event: OpenCodeEvent, signal: AbortSignal) {
      signal.throwIfAborted()
      if (event.location && event.location.directory !== host.location.directory) return
      if (event.type === "session.step.started") {
        started.set(event.data.assistantMessageID, {
          id: event.data.assistantMessageID, type: "assistant", agent: event.data.agent, model: event.data.model,
          time: { created: event.data.started }, content: [],
        })
        return
      }
      if (event.type === "session.compaction.ended") {
        const session = await host.session.get({ sessionID: event.data.sessionID }, { signal })
        if (session.location.directory !== host.location.directory) return
        const messages = await host.session.context({ sessionID: session.id }, { signal })
        signal.throwIfAborted()
        for (const message of messages) {
          if (message.type === "compaction" && isUsageMessage(message)) {
            ledger.recordLive({ ...usageFromMessage(message), sessionID: session.id, projectID: session.projectID, directory: session.location.directory }, event.created)
          }
        }
        return
      }
      if (event.type !== "session.step.ended" && event.type !== "session.step.failed") return
      const { assistantMessageID, sessionID } = event.data
      try {
        const session = await host.session.get({ sessionID }, { signal })
        if (session.location.directory !== host.location.directory) return
        let message = started.get(assistantMessageID)
        if (!message) {
          const messages = await host.session.context({ sessionID }, { signal })
          message = messages.find((item): item is SessionMessageAssistant => item.type === "assistant" && item.id === assistantMessageID)
        }
        signal.throwIfAborted()
        if (!message) return
        ledger.recordLive({
          ...usageFromMessage({ ...message, time: { ...message.time, completed: event.created },
            cost: event.data.cost ?? message.cost, tokens: event.data.tokens ?? message.tokens }),
          sessionID, projectID: session.projectID, directory: session.location.directory,
        }, event.created)
      } finally {
        started.delete(assistantMessageID)
      }
    },
  }
}
