import { paginate } from "@opcode/core/paginate"
import type { OpenCodeClient } from "@opencode/client"
import { messageRecord, type MessageRecord } from "./domain"
import { MAX_BATCH_BYTES, MAX_BATCH_MESSAGES, MAX_MESSAGE_TEXT, type SessionsRemote } from "./rpc"

export type HistorySource = { session: Pick<OpenCodeClient["session"], "list">; message: Pick<OpenCodeClient["message"], "list"> }

/** No filesystem/cache input: source and RPC must belong to the same connected client. */
export async function importHistory(client: HistorySource, remote: SessionsRemote, signal: AbortSignal) {
  let count = 0
  const pages = paginate((cursor) => client.session.list(cursor ? { cursor, limit: 100 } : { limit: 100 }, { signal }), signal)
  for await (const sessions of pages) {
    for (const session of sessions) {
      signal.throwIfAborted()
      const { token } = await remote.begin({ sessionID: session.id, updatedAt: session.time.updated }, signal)
      try {
        const messagePages = paginate((cursor) => client.message.list({ sessionID: session.id, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) }, { signal }), signal)
        for await (const messages of messagePages) {
          let batch: MessageRecord[] = []
          let bytes = 2
          const flush = async () => {
            if (!batch.length) return
            await remote.import({ token, messages: batch }, signal)
            batch = []; bytes = 2
          }
          for (const message of messages) {
            const row = messageRecord(message)
            if (!row) continue
            if (row.text.length > MAX_MESSAGE_TEXT || Buffer.byteLength(row.text, "utf8") > MAX_MESSAGE_TEXT) throw new Error("Historical message exceeds the 1 MiB upload limit; active context is still indexed.")
            const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1
            if (size + 2 > MAX_BATCH_BYTES) throw new Error("Historical message exceeds the 2 MiB upload limit.")
            if (batch.length >= MAX_BATCH_MESSAGES || bytes + size > MAX_BATCH_BYTES) await flush()
            batch.push(row); bytes += size
          }
          await flush()
        }
        count++
      } finally {
        // On cancellation tokens expire server-side; never start uncancellable cleanup I/O.
        if (!signal.aborted) await remote.finish(token, signal)
      }
    }
  }
  return count
}
