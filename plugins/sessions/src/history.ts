import type { OpenCodeClient } from "@opencode/client"
import { messageRecord, type MessageRecord } from "./domain"
import { MAX_BATCH_BYTES, MAX_BATCH_MESSAGES, MAX_MESSAGE_TEXT, type SessionsRemote } from "./rpc"

export type HistorySource = { session: Pick<OpenCodeClient["session"], "list">; message: Pick<OpenCodeClient["message"], "list"> }

/** No filesystem/cache input: source and RPC must belong to the same connected client. */
export async function importHistory(client: HistorySource, remote: SessionsRemote, signal: AbortSignal) {
  let cursor: string | undefined
  let count = 0
  const sessionCursors = new Set<string>()
  do {
    signal.throwIfAborted()
    const page = await client.session.list(cursor ? { cursor, limit: 100 } : { limit: 100 }, { signal })
    signal.throwIfAborted()
    for (const session of page.data) {
      signal.throwIfAborted()
      const { token } = await remote.begin({ sessionID: session.id, updatedAt: session.time.updated }, signal)
      try {
        let messageCursor: string | undefined
        const messageCursors = new Set<string>()
        do {
          signal.throwIfAborted()
          const messages = await client.message.list({ sessionID: session.id, limit: 100, ...(messageCursor ? { cursor: messageCursor } : { order: "asc" }) }, { signal })
          signal.throwIfAborted()
          let batch: MessageRecord[] = []
          let bytes = 2
          const flush = async () => {
            if (!batch.length) return
            await remote.import({ token, messages: batch }, signal)
            batch = []; bytes = 2
          }
          for (const message of messages.data) {
            const row = messageRecord(message)
            if (!row) continue
            if (row.text.length > MAX_MESSAGE_TEXT || Buffer.byteLength(row.text, "utf8") > MAX_MESSAGE_TEXT) throw new Error("Historical message exceeds the 1 MiB upload limit; active context is still indexed.")
            const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1
            if (size + 2 > MAX_BATCH_BYTES) throw new Error("Historical message exceeds the 2 MiB upload limit.")
            if (batch.length >= MAX_BATCH_MESSAGES || bytes + size > MAX_BATCH_BYTES) await flush()
            batch.push(row); bytes += size
          }
          await flush()
          messageCursor = messages.cursor.next ?? undefined
          if (messageCursor && messageCursors.has(messageCursor)) throw new Error("Server repeated a message cursor.")
          if (messageCursor) messageCursors.add(messageCursor)
        } while (messageCursor)
        count++
      } finally {
        // On cancellation tokens expire server-side; never start uncancellable cleanup I/O.
        if (!signal.aborted) await remote.finish(token, signal)
      }
    }
    cursor = page.cursor.next ?? undefined
    if (cursor && sessionCursors.has(cursor)) throw new Error("Server repeated a session cursor.")
    if (cursor) sessionCursors.add(cursor)
  } while (cursor)
  return count
}
