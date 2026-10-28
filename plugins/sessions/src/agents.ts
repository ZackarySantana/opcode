import type { OpenCodeEvent, SessionInfo } from "@opencode/client"
import { errorMessage } from "@opcode/core"
import type { Versioned } from "@opcode/core/follow"
import { consumeLive } from "@opcode/core/live"
import { failover, joinShared, packageVersion } from "@opcode/core/process"
import { setTimer, type SetTimer } from "@opcode/core/refresh"
import {
  activeRoots, applyEvent, applyObservation, decidedBy, emptyProjection, forgetInactive, INBOX_EVENTS, missingSessions, nextExpiry, reorder, rootOf,
  trackedSession, type AgentRow, type Observation, type Reads,
} from "./inbox"

/** Newest roots read on each snapshot; older unseen ones only appear once they become active again. */
const SNAPSHOT_ROOTS = 100
/** Changes within this long are announced together. */
const PUBLISH_DELAY = 100
/** How long to wait before reading the sessions again after a read failed. */
const LOAD_RETRY = 10_000
/** The longest delay timers support. */
const MAX_DELAY = 2 ** 31 - 1
/** Sessions, and decisions awaiting an observation, beyond which the service forgets what it no longer needs. */
const MAX_REMEMBERED = 1_000

/** The Agents list every terminal shows. */
export interface AgentsState extends Versioned {
  /** Listed roots, in the order they became active. */
  rows: AgentRow[]
  /**
   * While set, the service may have missed events, and asks terminals for an `Observation` of the host made after this
   * revision.
   */
  observe?: number
  error?: string
}

export type AttentionKind = "permission" | "form" | "finished" | "failed"

/** A transition each terminal may alert for: a new request, or a root's run finishing or failing unseen. */
export interface Attention {
  kind: AttentionKind
  /** The session that asked or finished. */
  sessionID: string
  /** Its root and the root's title, once known. */
  root?: string
  title?: string
}

/** `observe`'s input: an observation, made after the service's state was at `since`. */
export interface ObserveInput extends Observation { server: string; since: number }

/** What the service needs from its host: the server's events, its sessions, and a way to reach every terminal. */
export interface AgentsPorts {
  /** The server's live events, every location's. */
  events(signal: AbortSignal): AsyncIterable<OpenCodeEvent>
  roots(limit: number, signal: AbortSignal): Promise<SessionInfo[]>
  session(sessionID: string, signal: AbortSignal): Promise<SessionInfo>
  publish(state: AgentsState): Promise<void>
  attention(attention: Attention): Promise<void>
}

const warn = (what: string) => (error: unknown) => console.warn(`opcode-sessions: ${what}: ${errorMessage(error)}`)

/**
 * Active root sessions across every location, from a snapshot of the sessions plus the server's live events, in the
 * order they became active, and when each finish was read. Terminals contribute what the server can't read: which
 * sessions run and what they ask.
 */
export class AgentsService {
  private projection = emptyProjection()
  private order: string[] = []
  private reads: Reads = {}
  /** Rises with every change, announced or not. */
  private revision = 0
  /** While an observation is wanted: the revision each status entry or request was last decided at by an event. */
  private readonly decided = new Map<string, number>()
  private observeFrom?: number
  private error?: string
  /** What was last announced, so changes that don't show aren't. */
  private published?: string
  private cancelPublish?: () => void
  private cancelExpiry?: () => void
  private cancelRetry?: () => void
  private readonly lifetime = new AbortController()
  private readonly server = crypto.randomUUID()
  private readonly started = Date.now()
  /** Events received while a snapshot loads, replayed onto it. */
  private buffered?: OpenCodeEvent[]
  private reload = false
  private loading?: Promise<void>
  /** Sessions that couldn't be read, not asked for again until the next snapshot. */
  private readonly unavailable = new Set<string>()
  private resolving?: Promise<void>
  private again = false
  /** Settles once the first snapshot was read, or failed to be. */
  readonly ready: Promise<void>

  /** `keep`: how long, in milliseconds, a read finish stays listed. */
  constructor(private readonly ports: AgentsPorts, private readonly keep: number, private readonly timer: SetTimer = setTimer) {
    void consumeLive<OpenCodeEvent>({
      signal: this.lifetime.signal,
      subscribe: (signal) => ports.events(signal),
      handle: (event) => this.handle(event),
      // Events sent while disconnected are gone.
      onReconnect: () => this.resync(),
      // A stream ends whenever the location serving it unloads; snapshots report their own failures.
      warn: (error, source) => { if (source === "event") warn("an event couldn't be applied")(error) },
    })
    this.ready = this.resync()
  }

  state(): AgentsState {
    return {
      server: this.server, started: this.started, revision: this.revision, rows: this.rows(),
      ...this.observeFrom === undefined ? {} : { observe: this.observeFrom }, ...this.error ? { error: this.error } : {},
    }
  }

  /**
   * Corrects running sessions and requests by a terminal's observation, unless it predates the events the service may
   * have missed, or it isn't wanted. Events since `since` decide what they concern.
   */
  observe(input: ObserveInput): AgentsState {
    const wanted = this.observeFrom
    if (input.server === this.server && wanted !== undefined && input.since >= wanted && input.since <= this.revision) {
      this.update((projection) => applyObservation(projection, input, (key) => (this.decided.get(key) ?? -1) > input.since))
      this.observeFrom = undefined
      this.decided.clear()
    }
    return this.state()
  }

  dispose(): void {
    this.lifetime.abort()
    this.cancelPublish?.()
    this.cancelExpiry?.()
    this.cancelRetry?.()
  }

  private rows(): AgentRow[] {
    const active = new Map(activeRoots(this.projection, this.lingering()).map((root) => [root.id, root]))
    return this.order.flatMap((id) => {
      const root = active.get(id)
      const session = this.projection.sessions[id]
      return root && session ? [{ ...root, title: session.title, directory: session.directory }] : []
    })
  }

  private lingering() { return { reads: this.reads, keep: this.keep, now: Date.now() } }

  private handle(event: OpenCodeEvent) {
    if (!INBOX_EVENTS.has(event.type)) return
    this.buffered?.push(event)
    // Recorded first, so the read root keeps its place in the order.
    if (event.type === "session.viewed" && this.keep && this.reads[event.data.sessionID]?.idle !== event.data.idle) {
      this.reads[event.data.sessionID] = { idle: event.data.idle, at: event.created }
    }
    const decided = this.observeFrom === undefined ? [] : decidedBy(this.projection, event)
    this.update((projection) => applyEvent(projection, event), decided)
    if (event.type === "session.viewed" && this.keep) this.expire()
    if (event.type === "permission.asked") this.alert("permission", event.data.sessionID)
    if (event.type === "form.created") this.alert("form", event.data.form.sessionID)
    if (event.type === "session.idle") {
      const state = activeRoots(this.projection, this.lingering()).find((root) => root.id === event.data.sessionID)?.state
      if (state === "finished" || state === "failed") this.alert(state, event.data.sessionID)
    }
  }

  private alert(kind: AttentionKind, sessionID: string) {
    const root = rootOf(this.projection, sessionID)
    void this.ports.attention({ kind, sessionID, ...root ? { root: root.id, title: root.title } : {} }).catch(warn("couldn't announce an alert"))
  }

  /** Mutate, keep the activation order, announce, and fetch sessions the change refers to. */
  private update(mutate: (projection: typeof this.projection) => void, decided: readonly string[] = []) {
    mutate(this.projection)
    this.revision++
    for (const key of decided) this.decided.set(key, this.revision)
    // The service outlives terminals: what it remembers stays bounded however long none answers or sessions pile up.
    if (this.decided.size > MAX_REMEMBERED) {
      // Decisions only matter to observations made before them; asking for a newer one makes these moot.
      this.observeFrom = this.revision
      this.decided.clear()
    }
    if (Object.keys(this.projection.sessions).length > MAX_REMEMBERED) forgetInactive(this.projection, this.lingering())
    this.order = reorder(this.order, activeRoots(this.projection, this.lingering()))
    this.changed()
    this.resolve()
  }

  /** Announces the state after a short while, once for changes close together, and only when it shows something new. */
  private changed() {
    if (this.lifetime.signal.aborted || this.cancelPublish) return
    this.cancelPublish = this.timer(() => {
      this.cancelPublish = undefined
      if (this.lifetime.signal.aborted) return
      const state = this.state()
      const shown = JSON.stringify([state.rows, state.observe, state.error])
      if (shown === this.published) return
      this.published = shown
      void this.ports.publish(state).catch((error) => {
        if (this.published === shown) this.published = undefined
        warn("couldn't announce a change")(error)
      })
    }, PUBLISH_DELAY)
  }

  /** Each read drops out of the list once its time is up; one timer waits for the next. */
  private expire() {
    this.cancelExpiry?.()
    const now = Date.now()
    for (const [id, read] of Object.entries(this.reads)) if (read.at + this.keep <= now) delete this.reads[id]
    this.update(() => {})
    const next = nextExpiry({ reads: this.reads, keep: this.keep, now })
    if (next !== undefined && !this.lifetime.signal.aborted) this.cancelExpiry = this.timer(() => this.expire(), Math.min(next - now, MAX_DELAY))
  }

  /** Events may have been missed: reads the sessions again, and asks terminals what runs. */
  private resync() {
    this.observeFrom = this.revision + 1
    this.decided.clear()
    this.update(() => {})
    return this.snapshot()
  }

  /**
   * Reads the newest roots. Events received meanwhile are replayed onto them; each event fully determines the fields it
   * sets. Status and requests stay as live events and observations left them: replaying older events would undo an
   * observation made since. A failed read keeps the sessions it had, and is tried again on a timer.
   */
  private snapshot(): Promise<void> {
    this.reload = true
    this.cancelRetry?.()
    const signal = this.lifetime.signal
    return this.loading ??= (async () => {
      let sessions: typeof this.projection.sessions | undefined
      while (this.reload && !signal.aborted) {
        this.reload = false
        this.buffered = []
        this.unavailable.clear()
        try {
          const roots = await this.ports.roots(SNAPSHOT_ROOTS, signal)
          sessions = Object.fromEntries(roots.map((info) => [info.id, trackedSession(info)]))
          this.error = undefined
        } catch (error) {
          sessions = undefined
          if (!signal.aborted) this.error = errorMessage(error)
        }
      }
      const replay = this.buffered ?? []
      this.buffered = this.loading = undefined
      if (signal.aborted) return
      if (!sessions) {
        this.cancelRetry = this.timer(() => void this.snapshot(), LOAD_RETRY)
        return this.changed()
      }
      const fresh = { ...emptyProjection(), sessions }
      for (const event of replay) applyEvent(fresh, event)
      this.update((projection) => { projection.sessions = fresh.sessions })
    })()
  }

  /** Status and requests can name sessions not read yet; their chains are fetched up to the root. */
  private resolve() {
    this.again = true
    const signal = this.lifetime.signal
    this.resolving ??= (async () => {
      try {
        while (this.again && !signal.aborted) {
          this.again = false
          const ids = missingSessions(this.projection).filter((id) => !this.unavailable.has(id))
          await Promise.all(ids.map(async (sessionID) => {
            try {
              const info = await this.ports.session(sessionID, signal)
              if (!signal.aborted) this.update((projection) => { projection.sessions[info.id] ??= trackedSession(info) })
            } catch { if (!signal.aborted) this.unavailable.add(sessionID) }
          }))
        }
      } finally { this.resolving = undefined }
    })()
  }
}

/**
 * The server process's service, which every location instance joins with its own ports. `start` runs only for the first
 * to join. Events come from one member at a time, the oldest: each location's stream carries every location's events.
 * A member's stream must end when it leaves, so the next takes over; reads and announcements fail over to the next.
 */
export function joinAgents(member: AgentsPorts, start: (ports: AgentsPorts) => AgentsService) {
  const { value, leave } = joinShared(`opcode-sessions.agents@${packageVersion(new URL("../package.json", import.meta.url))}`, member, {
    start: (members) => start({
      events: (signal) => {
        const current = members()[0]
        if (!current) throw new Error("No plugin instance is loaded")
        return current.events(signal)
      },
      roots: (limit, signal) => failover(members, (ports) => ports.roots(limit, signal)),
      session: (sessionID, signal) => failover(members, (ports) => ports.session(sessionID, signal)),
      publish: (state) => failover(members, (ports) => ports.publish(state)),
      attention: (attention) => failover(members, (ports) => ports.attention(attention)),
    }),
    stop: (service) => service.dispose(),
  })
  return { service: value, leave }
}
