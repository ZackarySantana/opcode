import { paginate } from "@opcode/core/paginate"
import type { OpenCodeClient } from "@opencode/client"
import { messageRecord, type HistoryOutput, type MessageRecord } from "./domain"
import { MAX_BATCH_BYTES, MAX_BATCH_MESSAGES, MAX_MESSAGE_TEXT, sessionErrorType, type SessionsRemote } from "./rpc"

export type HistorySource = { session: Pick<OpenCodeClient["session"], "list">; message: Pick<OpenCodeClient["message"], "list"> }

/**
 * No filesystem/cache input: source and RPC must belong to the same connected client.
 * Deleted or changed sessions are skipped, and oversized messages are left out rather than
 * truncated; both are counted. Other failures (connection, server) stop the pass.
 */
export async function importHistory(client: HistorySource, remote: SessionsRemote, signal: AbortSignal): Promise<HistoryOutput> {
  const result: HistoryOutput = { imported: 0, unchanged: 0, skipped: 0, oversized: 0 }
  const pages = paginate((cursor) => client.session.list(cursor ? { cursor, limit: 100 } : { limit: 100 }, { signal }), signal)
  for await (const sessions of pages) {
    for (const session of sessions) {
      signal.throwIfAborted()
      let token: string | undefined
      let complete = false
      try {
        const started = await remote.begin({ sessionID: session.id, updatedAt: session.time.updated }, signal)
        if (started.current || !started.token) { result.unchanged++; continue }
        token = started.token
        const messagePages = paginate((cursor) => client.message.list({ sessionID: session.id, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) }, { signal }), signal)
        for await (const messages of messagePages) {
          let batch: MessageRecord[] = []
          let bytes = 2
          const flush = async () => {
            if (!batch.length) return
            await remote.import({ token: token!, messages: batch }, signal)
            batch = []; bytes = 2
          }
          for (const message of messages) {
            const row = messageRecord(message)
            if (!row) continue
            const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1
            if (row.text.length > MAX_MESSAGE_TEXT || Buffer.byteLength(row.text, "utf8") > MAX_MESSAGE_TEXT || size + 2 > MAX_BATCH_BYTES) { result.oversized++; continue }
            if (batch.length >= MAX_BATCH_MESSAGES || bytes + size > MAX_BATCH_BYTES) await flush()
            batch.push(row); bytes += size
          }
          await flush()
        }
        complete = true
        result.imported++
      } catch (error) {
        const type = sessionErrorType(error)
        if (signal.aborted || (type !== "missing" && type !== "stale")) throw error
        result.skipped++
      } finally {
        // On cancellation tokens expire server-side; never start uncancellable cleanup I/O.
        // A failed release must not mask the session's own outcome.
        if (token && !signal.aborted) {
          try { await remote.finish({ token, complete }, signal) } catch { if (complete) { result.imported--; result.skipped++ } }
        }
      }
    }
  }
  return result
}
