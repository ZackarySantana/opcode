import { paginate } from "@opcode/core/paginate"
import type { OpenCodeClient } from "@opencode/client"
import { IMPORT_BATCH_SIZE } from "./domain.js"
import type { CostService } from "./client.js"
import { activityFromMessage, isUsageMessage, usageFromMessage } from "./messages.js"

/** Only these message types carry usage or turn boundaries; the server filters, the client still checks. */
const TYPES = ["assistant", "compaction", "user", "idle"] as const

/** A server plugin cannot list message history in OpenCode 2.2.0 (its `session` domain has no message listing), so a client reads it. */
export async function importProject(
  client: Pick<OpenCodeClient, "session" | "message">,
  service: CostService,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const status = await service.status(signal)
  const sessions = paginate((cursor) => client.session.list({ project: status.projectID, cursor, limit: IMPORT_BATCH_SIZE }, { signal }), signal)
  for await (const page of sessions) {
    for (const session of page) {
      if (session.projectID !== status.projectID) throw new Error("Session list returned another project")
      // Like `order`, the filter is a first-page parameter: later cursors carry it.
      for (const type of TYPES) {
        const messages = paginate((cursor) => client.message.list({ sessionID: session.id, limit: IMPORT_BATCH_SIZE, ...(cursor ? { cursor } : { type }) }, { signal }), signal)
        for await (const messagePage of messages) {
          // Prompt text never leaves the terminal: only marker times are sent.
          await send(messagePage.filter(isUsageMessage).map(usageFromMessage), (records) => service.importBatch({ sessionID: session.id, records }, signal), signal)
          await send(messagePage.flatMap((message) => activityFromMessage(message) ?? []), (activity) => service.importActivity({ sessionID: session.id, activity }, signal), signal)
        }
      }
    }
  }
  signal.throwIfAborted()
  // Informational completion timestamp, NOT a permanent skip marker.
  await service.completeImport(signal)
}

/** Bound writes even if a server ignores the requested page size. */
async function send<T>(items: T[], write: (batch: T[]) => Promise<void>, signal: AbortSignal) {
  for (let offset = 0; offset < items.length; offset += IMPORT_BATCH_SIZE) {
    signal.throwIfAborted()
    await write(items.slice(offset, offset + IMPORT_BATCH_SIZE))
  }
}
