import { createSerialQueue } from "@opcode/core"
import type { OpenCodeClient } from "@opencode/client"
import { IMPORT_BATCH_SIZE } from "./domain.js"
import type { CostService } from "./client.js"
import { isUsageMessage, usageFromMessage } from "./messages.js"

/** Full history is only exposed by the TUI's client in OpenCode 2.1.1. */
export async function importProject(
  client: Pick<OpenCodeClient, "session" | "message">,
  service: CostService,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const status = await service.status(signal)
  let cursor: string | undefined
  const sessionCursors = new Set<string>()
  do {
    signal.throwIfAborted()
    const page = await client.session.list({ project: status.projectID, cursor, limit: IMPORT_BATCH_SIZE }, { signal })
    signal.throwIfAborted()
    for (const session of page.data) {
      if (session.projectID !== status.projectID) throw new Error("Session list returned another project")
      let messageCursor: string | undefined
      const messageCursors = new Set<string>()
      do {
        signal.throwIfAborted()
        const messages = await client.message.list({ sessionID: session.id, cursor: messageCursor, limit: IMPORT_BATCH_SIZE }, { signal })
        signal.throwIfAborted()
        const records = messages.data.filter(isUsageMessage).map(usageFromMessage)
        // Bound writes even if a server ignores the requested page size.
        for (let offset = 0; offset < records.length; offset += IMPORT_BATCH_SIZE) {
          signal.throwIfAborted()
          await service.importBatch({ sessionID: session.id, records: records.slice(offset, offset + IMPORT_BATCH_SIZE) }, signal)
        }
        messageCursor = messages.cursor.next ?? undefined
        checkCursor(messageCursors, messageCursor)
      } while (messageCursor)
    }
    cursor = page.cursor.next ?? undefined
    checkCursor(sessionCursors, cursor)
  } while (cursor)
  signal.throwIfAborted()
  // Informational completion timestamp, NOT a permanent skip marker.
  await service.completeImport(signal)
}

function checkCursor(seen: Set<string>, cursor: string | undefined) {
  if (!cursor) return
  if (seen.has(cursor)) throw new Error("History pagination repeated a cursor")
  seen.add(cursor)
}

/** Coalesce repeat refreshes for one location; serialize imports without poisoning retries. */
export function createImportRunner<T>(key: (target: T) => string, work: (target: T) => Promise<void>) {
  const queue = createSerialQueue()
  const pending = new Map<string, Promise<void>>()
  return (target: T) => {
    const id = key(target)
    const current = pending.get(id)
    if (current) return current
    const task = queue(() => work(target)).finally(() => { pending.delete(id) })
    pending.set(id, task)
    return task
  }
}
