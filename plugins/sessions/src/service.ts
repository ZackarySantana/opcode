import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { isSessionNotFoundError } from "@opencode/client"
import { paginate } from "@opcode/core/paginate"
import { messageRecord, sessionRecord, type MessageRecord, type SearchInput } from "./domain"
import type { acquireIndex } from "./index-store"
import { validateBatch } from "./rpc"

export type SessionSource = { session: Pick<OpenCodeClient["session"], "list" | "get" | "context"> }
type Lease = ReturnType<typeof acquireIndex>
type ImportToken = { sessionID: string; updatedAt: number; expires: number }

export function isMissing(error: unknown) {
  return isSessionNotFoundError(error)
}

/** Owns host I/O; the index never fetches data or decides which server to contact. */
export class SessionsService {
  private readonly tokens = new Map<string, ImportToken>()
  private readonly operations = new Set<Promise<unknown>>()
  constructor(private readonly source: SessionSource, private readonly lease: Lease, private readonly lifetime: AbortSignal) {}

  /** Track host I/O for teardown, but never hold the shared index queue while fetching it. */
  private operation<T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>) {
    const combined = signal ? AbortSignal.any([signal, this.lifetime]) : this.lifetime
    const pending = Promise.resolve().then(() => { combined.throwIfAborted(); return action(combined) })
    this.operations.add(pending)
    void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending))
    return pending
  }

  /** Only local snapshots, bounded session/batch commits, and searches share this queue. */
  private commit<T>(signal: AbortSignal, action: () => T | Promise<T>) {
    return this.lease.serial(async () => { signal.throwIfAborted(); return action() })
  }

  search(input: SearchInput, signal?: AbortSignal) {
    return this.operation(signal, (active) => this.commit(active, async () => ({ rows: await this.lease.index.search(input, active), projects: this.lease.index.projects() })))
  }

  private async read(id: string, signal: AbortSignal) {
    try { return await this.source.session.get({ sessionID: id }, { signal }) } catch (error) {
      if (isMissing(error)) await this.commit(signal, () => this.lease.index.remove(id))
      throw error
    }
  }

  private async indexOne(id: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await this.commit(signal, () => this.lease.index.deleted(id))) return
      const before = await this.read(id, signal)
      let context
      try { context = await this.source.session.context({ sessionID: id }, { signal }) } catch (error) {
        if (isMissing(error)) await this.commit(signal, () => this.lease.index.remove(id))
        throw error
      }
      const after = await this.read(id, signal)
      signal.throwIfAborted()
      if (before.time.updated !== after.time.updated || before.location.directory !== after.location.directory) continue
      const messages = context.flatMap((message) => { const row = messageRecord(message); return row ? [row] : [] })
      await this.commit(signal, () => this.lease.index.write(sessionRecord(after), messages))
      return
    }
    throw new Error("Session changed while indexing; retry refresh when it is idle.")
  }

  syncSession(id: string, signal?: AbortSignal) { return this.operation(signal, (active) => this.indexOne(id, active)) }
  remove(id: string) { return this.operation(undefined, (active) => this.commit(active, () => { this.lease.index.remove(id) })) }

  /** Only reconcile after complete authoritative enumeration, never after a failed page. */
  refresh(signal?: AbortSignal, directory?: string) {
    return this.operation(signal, async (active) => {
      const before = await this.commit(active, () => this.lease.index.ids(directory))
      const seen = new Set<string>()
      // After the first page, the cursor carries the directory filter.
      const pages = paginate((cursor) => this.source.session.list(cursor ? { cursor, limit: 100 } : { ...(directory ? { directory } : {}), limit: 100 }, { signal: active }), active)
      for await (const page of pages) {
        for (const session of page) {
          seen.add(session.id)
          try { await this.indexOne(session.id, active) } catch (error) { if (!isMissing(error)) throw error }
        }
      }
      active.throwIfAborted()
      for (const id of before) if (!seen.has(id)) {
        // A missing directory-list entry can be a move, not a deletion. Confirm by ID.
        try { await this.indexOne(id, active) } catch (error) { if (!isMissing(error)) throw error }
      }
      return { sessions: seen.size }
    })
  }

  begin(input: { sessionID: string; updatedAt: number }, signal?: AbortSignal) {
    return this.operation(signal, async (active) => {
      const session = await this.read(input.sessionID, active)
      return this.commit(active, () => {
        for (const [token, value] of this.tokens) if (value.expires < Date.now()) this.tokens.delete(token)
        if (this.tokens.size >= 128) throw new Error("Too many pending history imports; retry later.")
        if (this.lease.index.deleted(session.id) || session.time.updated !== input.updatedAt) throw new Error("Session changed before history import; refresh again.")
        const token = crypto.randomUUID()
        this.tokens.set(token, { sessionID: session.id, updatedAt: session.time.updated, expires: Date.now() + 120_000 })
        return { token }
      })
    })
  }

  import(input: { token: string; messages: MessageRecord[] }, signal?: AbortSignal) {
    validateBatch(input.messages)
    return this.operation(signal, async (active) => {
      const token = this.tokens.get(input.token)
      if (!token || token.expires < Date.now()) throw new Error("History import expired; refresh again.")
      let session: SessionInfo
      try { session = await this.read(token.sessionID, active) } catch (error) { this.tokens.delete(input.token); throw error }
      return this.commit(active, () => {
        if (this.tokens.get(input.token) !== token || token.expires < Date.now()) throw new Error("History import expired; refresh again.")
        if (session.time.updated !== token.updatedAt || this.lease.index.deleted(session.id)) {
          this.tokens.delete(input.token)
          throw new Error("Session changed during history import; refresh again.")
        }
        if (!this.lease.index.write(sessionRecord(session), input.messages)) throw new Error("History import is stale or session was deleted.")
        token.expires = Date.now() + 120_000
        return { accepted: input.messages.length }
      })
    })
  }

  finish(token: string) { this.tokens.delete(token) }
  async settled() {
    while (this.operations.size) await Promise.allSettled([...this.operations])
    await this.lease.serial(async () => {})
  }
}
