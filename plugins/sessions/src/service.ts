import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { isSessionNotFoundError } from "@opencode/client"
import { paginate } from "@opcode/core/paginate"
import { messageRecord, sessionRecord, type MessageRecord, type RefreshOutput, type SearchInput } from "./domain"
import { observedNow, type acquireIndex } from "./index-store"
import { validateBatch } from "./rpc"

export type SessionSource = { session: Pick<OpenCodeClient["session"], "list" | "get" | "context"> }
type Lease = ReturnType<typeof acquireIndex>
type ImportToken = { sessionID: string; updatedAt: number; expires: number }

/** The session moved on while it was read or uploaded; retry when it is idle. Not a failure. */
export class StaleSessionError extends Error {}
/** The session was deleted (or tombstoned) before the request could apply. */
export class MissingSessionError extends Error {}

function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/** Owns host I/O; the index never fetches data or decides which server to contact. */
export class SessionsService {
  private readonly tokens = new Map<string, ImportToken>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly refreshes = new Map<string, { running: Promise<RefreshOutput>; next?: Promise<RefreshOutput> }>()
  constructor(private readonly source: SessionSource, private readonly lease: Lease, private readonly lifetime: AbortSignal) {}

  /** Track host I/O for teardown, but never hold the shared index queue while fetching it. */
  private operation<T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>) {
    const combined = signal ? AbortSignal.any([signal, this.lifetime]) : this.lifetime
    const pending = Promise.resolve().then(() => { combined.throwIfAborted(); return action(combined) })
    this.operations.add(pending)
    void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending))
    return pending
  }

  /** Only local snapshots and bounded session/batch commits share this queue. */
  private commit<T>(signal: AbortSignal, action: () => T | Promise<T>) {
    return this.lease.serial(async () => { signal.throwIfAborted(); return action() })
  }

  /** Synchronous SQLite reads cannot interleave with queued writes; matching runs off-thread. */
  search(input: SearchInput, signal?: AbortSignal) {
    return this.operation(signal, async (active) => ({ ...await this.lease.index.search(input, active), projects: this.lease.index.projects() }))
  }

  private async host<T>(id: string, signal: AbortSignal, request: () => Promise<T>) {
    try { return await request() } catch (error) {
      if (isSessionNotFoundError(error)) await this.commit(signal, () => this.lease.index.remove(id))
      throw error
    }
  }

  private async indexOne(id: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const observed = observedNow()
      const before = await this.host(id, signal, () => this.source.session.get({ sessionID: id }, { signal }))
      const context = await this.host(id, signal, () => this.source.session.context({ sessionID: id }, { signal }))
      const after = await this.host(id, signal, () => this.source.session.get({ sessionID: id }, { signal }))
      signal.throwIfAborted()
      if (before.time.updated !== after.time.updated || before.location.directory !== after.location.directory) continue
      const messages = context.flatMap((message) => { const row = messageRecord(message); return row ? [row] : [] })
      const through = context.reduce((newest, message) => message.id > newest ? message.id : newest, "")
      await this.commit(signal, () => {
        this.lease.index.revive(id, observed)
        this.lease.index.write(sessionRecord(after), messages, through)
      })
      return
    }
    throw new StaleSessionError("Session changed while indexing; it will be indexed when idle.")
  }

  syncSession(id: string, signal?: AbortSignal) { return this.operation(signal, (active) => this.indexOne(id, active)) }
  remove(id: string) { return this.operation(undefined, (active) => this.commit(active, () => { this.lease.index.remove(id) })) }

  /**
   * Single flight per directory: overlapping callers share the running pass, and requests that
   * arrive during it share one follow-up pass. A caller's signal only stops its own wait.
   */
  refresh(signal?: AbortSignal, directory?: string) {
    const key = directory ?? ""
    const entry = this.refreshes.get(key)
    const start = () => {
      const running = this.operation(undefined, (active) => this.reconcile(active, directory))
      const next = { running }
      this.refreshes.set(key, next)
      void running.catch(() => {}).finally(() => {
        const current = this.refreshes.get(key)
        if (current === next && !current.next) this.refreshes.delete(key)
      })
      return running
    }
    let shared: Promise<RefreshOutput>
    if (!entry) shared = start()
    else shared = entry.next ??= entry.running.catch(() => {}).then(start)
    return signal ? abortable(shared, signal) : shared
  }

  /** Only reconcile after complete authoritative enumeration, never after a failed page. */
  private async reconcile(signal: AbortSignal, directory?: string): Promise<RefreshOutput> {
    const before = await this.commit(signal, () => this.lease.index.ids(directory))
    const seen = new Set<string>()
    let deferred = 0
    let failed = 0
    // One busy or broken session must not stop the pass or deletion reconciliation.
    const attempt = async (id: string) => {
      try { await this.indexOne(id, signal) } catch (error) {
        signal.throwIfAborted()
        if (error instanceof StaleSessionError) deferred++
        else if (!isSessionNotFoundError(error)) failed++
      }
    }
    // After the first page, the cursor carries the directory filter.
    const pages = paginate((cursor) => this.source.session.list(cursor ? { cursor, limit: 100 } : { ...(directory ? { directory } : {}), limit: 100 }, { signal }), signal)
    for await (const page of pages) {
      for (const session of page) {
        seen.add(session.id)
        if (!await this.commit(signal, () => this.lease.index.current(sessionRecord(session)))) await attempt(session.id)
      }
    }
    signal.throwIfAborted()
    // A missing directory-list entry can be a move, not a deletion. Confirm by ID.
    for (const id of before) if (!seen.has(id)) await attempt(id)
    return { sessions: seen.size, deferred, failed }
  }

  begin(input: { sessionID: string; updatedAt: number }, signal?: AbortSignal) {
    return this.operation(signal, async (active): Promise<{ current: boolean; token?: string }> => {
      const issue = (sessionID: string, updatedAt: number) => {
        for (const [token, value] of this.tokens) if (value.expires < Date.now()) this.tokens.delete(token)
        if (this.tokens.size >= 128) throw new Error("Too many pending history imports; retry later.")
        const token = crypto.randomUUID()
        this.tokens.set(token, { sessionID, updatedAt, expires: Date.now() + 120_000 })
        return token
      }
      // Current sessions still get a token so older TUIs (which always upload) keep working; uploads are revision-checked.
      const current = await this.commit(active, () => this.lease.index.historyCurrent(input.sessionID, input.updatedAt) ? issue(input.sessionID, input.updatedAt) : undefined)
      if (current) return { current: true, token: current }
      const session = await this.host(input.sessionID, active, () => this.source.session.get({ sessionID: input.sessionID }, { signal: active }))
      return this.commit(active, () => {
        if (this.lease.index.deleted(session.id)) throw new MissingSessionError("Session was deleted before history import.")
        if (session.time.updated !== input.updatedAt) throw new StaleSessionError("Session changed before history import; it will be imported when idle.")
        return { current: false, token: issue(session.id, session.time.updated) }
      })
    })
  }

  import(input: { token: string; messages: MessageRecord[] }, signal?: AbortSignal) {
    validateBatch(input.messages)
    return this.operation(signal, async (active) => {
      const token = this.tokens.get(input.token)
      if (!token || token.expires < Date.now()) throw new StaleSessionError("History import expired; refresh again.")
      let session: SessionInfo
      try { session = await this.host(token.sessionID, active, () => this.source.session.get({ sessionID: token.sessionID }, { signal: active })) } catch (error) { this.tokens.delete(input.token); throw error }
      return this.commit(active, () => {
        if (this.tokens.get(input.token) !== token || token.expires < Date.now()) throw new StaleSessionError("History import expired; refresh again.")
        if (this.lease.index.deleted(session.id)) { this.tokens.delete(input.token); throw new MissingSessionError("Session was deleted during history import.") }
        if (session.time.updated !== token.updatedAt || !this.lease.index.write(sessionRecord(session), input.messages)) {
          this.tokens.delete(input.token)
          throw new StaleSessionError("Session changed during history import; it will be imported when idle.")
        }
        token.expires = Date.now() + 120_000
        return { accepted: input.messages.length }
      })
    })
  }

  /** Every upload was revision-checked, so a completed token's revision is fully imported. */
  finish(input: { token: string; complete?: boolean }) {
    const token = this.tokens.get(input.token)
    this.tokens.delete(input.token)
    if (input.complete !== true || !token || token.expires < Date.now()) return Promise.resolve()
    return this.operation(undefined, (active) => this.commit(active, () => this.lease.index.markHistory(token.sessionID, token.updatedAt)))
  }

  async settled() {
    while (this.operations.size) await Promise.allSettled([...this.operations])
    await this.lease.serial(async () => {})
  }
}
