import { errorMessage } from "./index"
import { consumeLive } from "./live"
import { setTimer, type SetTimer } from "./refresh"

/** A full state from a server-side service, ordered by which service made it and when. */
export interface Versioned {
  /** The server process's service that produced it. */
  readonly server: string
  /** When that service started, on the server's clock, so a client prefers the newest service, such as after a restart. */
  readonly started: number
  /** Rises with each change within a service. */
  readonly revision: number
}

/** `Versioned`'s JSON Schema properties, to spread into a state's schema. */
export const versionedSchema = {
  server: { type: "string" }, started: { type: "number" }, revision: { type: "integer", minimum: 0 },
} as const

/** Whether `next` replaces `current`: a later service's state does, and within one service a later revision. */
export function newer(next: Versioned, current: Versioned | undefined): boolean {
  if (!current) return true
  if (next.server !== current.server) return next.started >= current.started
  return next.revision > current.revision
}

/**
 * Follows a server's full state: reads it, applies each announced change, and reads again whenever it may have missed
 * one, since announcements are live only. States can arrive twice or out of order, from a call and from an
 * announcement, so only newer ones apply. `problem` reports why the state couldn't be read, or a failed call, until the
 * next state arrives.
 */
export function followState<State extends Versioned>(options: {
  read(signal: AbortSignal): Promise<State>
  changes(signal: AbortSignal): AsyncIterable<State>
  /** Each state newer than the last applied. */
  apply(state: State): void
  problem(message: string | undefined): void
  describe?(error: unknown): string
  timer?: SetTimer
  /** How long to wait before reading again after a read failed. */
  retryMilliseconds?: number
}) {
  const timer = options.timer ?? setTimer
  const describe = options.describe ?? errorMessage
  const lifetime = new AbortController()
  let current: State | undefined
  let cancelRetry: (() => void) | undefined

  const offer = (state: State) => {
    if (lifetime.signal.aborted) return
    options.problem(undefined)
    if (!newer(state, current)) return
    current = state
    options.apply(state)
  }
  const resync = async () => {
    cancelRetry?.()
    try { offer(await options.read(lifetime.signal)) } catch (error) {
      if (lifetime.signal.aborted) return
      options.problem(describe(error))
      cancelRetry?.()
      cancelRetry = timer(() => void resync(), options.retryMilliseconds ?? 30_000)
    }
  }
  return {
    start() {
      void consumeLive({
        signal: lifetime.signal,
        subscribe: (signal) => options.changes(signal),
        handle: offer,
        // Changes announced while disconnected are gone.
        onReconnect: resync,
        // Reads report what clients need to know.
        warn: () => {},
      })
      void resync()
    },
    /** A state from a call, such as the answer to a change. */
    offer,
    /** Reads the whole state again, such as when announcements seem to have stopped. */
    resync,
    /** A failed call may have missed changes: reads them, then reports the failure. */
    async failed(error: unknown) {
      await resync()
      if (!lifetime.signal.aborted) options.problem(describe(error))
    },
    dispose() {
      lifetime.abort()
      cancelRetry?.()
    },
  }
}

/**
 * Whether a state's next refresh, due at `next`, is long overdue at `now`, which means news stopped, such as when the
 * server unloaded the plugin from every location: reading again starts it there. True once per due time.
 */
export function createOverdue(grace = 60_000) {
  let reported: number | undefined
  return (next: number | undefined, refreshing: boolean, now: number): boolean => {
    if (next === undefined || next === reported || refreshing || now <= next + grace) return false
    reported = next
    return true
  }
}
