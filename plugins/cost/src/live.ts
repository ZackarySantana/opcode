import type { OpenCodeEvent, SessionMessageAssistant } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import type { ActivityKind } from "./domain.js"
import { isUsageMessage, timedSession, usageFromMessage } from "./messages.js"
import type { CostLedger } from "./ledger.js"

type Host = { location: { directory: string }; session: Pick<Plugin.Context["session"], "get" | "context"> }

/** Steps that never end, and prompts never delivered, must not grow memory without bound. */
const MAX_PENDING = 256

export function createLiveCollector(host: Host, ledger: CostLedger) {
  const started = new Map<string, SessionMessageAssistant>()
  // Delivery events do not say what was delivered; only user prompts end a wait. A prompt enqueued before
  // activation or a reconnect is missed live and recovered by the next import.
  const prompts = new Set<string>()
  const activity = async (sessionID: string, kind: ActivityKind, at: number, signal: AbortSignal) => {
    const session = await host.session.get({ sessionID }, { signal })
    const timed = timedSession(session)
    signal.throwIfAborted()
    if (timed && session.location.directory === host.location.directory) ledger.recordActivity(timed, [{ kind, at }])
  }
  return {
    clear: () => { started.clear(); prompts.clear() },
    /** Host reads may overlap other work; each ledger write runs synchronously after a final abort check. */
    async handle(event: OpenCodeEvent, signal: AbortSignal) {
      signal.throwIfAborted()
      if (event.location && event.location.directory !== host.location.directory) {
        if ("assistantMessageID" in event.data) started.delete(event.data.assistantMessageID)
        return
      }
      if (event.type === "session.step.started") {
        const id = event.data.assistantMessageID
        started.delete(id)
        started.set(id, {
          id, type: "assistant", agent: event.data.agent, model: event.data.model,
          time: { created: event.data.started }, content: [],
        })
        if (started.size > MAX_PENDING) started.delete(started.keys().next().value!)
        return
      }
      if (event.type === "session.inbox.enqueued") {
        if (event.data.item.type === "user") prompts.add(event.data.inboxID)
        if (prompts.size > MAX_PENDING) prompts.delete(prompts.values().next().value!)
        return
      }
      if (event.type === "session.inbox.delivered") {
        if (prompts.delete(event.data.inboxID)) await activity(event.data.sessionID, "prompt", event.created, signal)
        return
      }
      // History has an idle message for each of these except a shutdown interruption, which live still records
      // so that work resumed after a restart does not extend the interrupted turn across the downtime.
      if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
        await activity(event.data.sessionID, "idle", event.created, signal)
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
        // A started step carries no usage; a context read does.
        const fromContext = !message
        if (!message) {
          const messages = await host.session.context({ sessionID }, { signal })
          message = messages.find((item): item is SessionMessageAssistant => item.type === "assistant" && item.id === assistantMessageID)
        }
        signal.throwIfAborted()
        if (!message) return
        // Like the host, a failure replaces usage only when it reports both cost and tokens. A retried
        // step reuses its message, so a failure without usage must not erase earlier recorded usage.
        const reported = event.data.cost !== undefined && event.data.tokens !== undefined
        ledger.recordLive({
          ...usageFromMessage({ ...message, time: { ...message.time, completed: event.created },
            cost: reported ? event.data.cost : message.cost, tokens: reported ? event.data.tokens : message.tokens }),
          sessionID, projectID: session.projectID, directory: session.location.directory,
        }, event.created, { usage: reported || fromContext })
      } finally {
        started.delete(assistantMessageID)
      }
    },
  }
}
