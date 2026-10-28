import type { OpenCodeEvent, SessionInfo } from "@opencode/client"

/** What a root session's family waits on, most urgent first. */
export type AgentState = "needs-you" | "failed" | "finished" | "retrying" | "working"

export interface TrackedSession {
  id: string
  parentID?: string
  directory: string
  title: string
  /** The latest observed activity anywhere on this session. */
  updated: number
  idle?: number
  viewed?: number
  archived: boolean
  outcome?: SessionInfo["outcome"]
}

/** The server's projection of host state. Status and requests may name sessions whose metadata is still loading. */
export interface Projection {
  sessions: Record<string, TrackedSession>
  /** Absent means idle. A retry with an action waits on you. */
  status: Record<string, "busy" | "retry" | "action">
  /** `permission:<id>` or `form:<id>` to the asking session. */
  requests: Record<string, string>
}

export interface ActiveRoot {
  id: string
  state: AgentState
  /** Finished or failed and already viewed, so listed only for a while. */
  read: boolean
  /** Busy subagents rolled up into this root. */
  agents: number
  /** When it finished, or its family's latest activity. */
  since: number
}

/** A listed root, with what its row shows. */
export interface AgentRow extends ActiveRoot { title: string; directory: string }

/** When each session's idle was first viewed. The server records only which idle was viewed; live events tell when. */
export type Reads = Record<string, { idle: number; at: number }>

/** Viewed finishes stay listed until `keep` milliseconds after they were read. */
export interface Lingering { reads: Reads; keep: number; now: number }

/** The next time a listed read drops out, if any is still listed. */
export function nextExpiry({ reads, keep, now }: Lingering) {
  const times = Object.values(reads).map((read) => read.at + keep).filter((time) => time > now)
  return times.length ? Math.min(...times) : undefined
}

export const emptyProjection = (): Projection => ({ sessions: {}, status: {}, requests: {} })

/** The `inbox` plugin option's fields, of any shape. */
export const inboxOption = (value: unknown) => (value && typeof value === "object" ? value : {}) as Record<string, unknown>

/** An integer option of at least `minimum`, else `fallback`. */
export const countOption = (value: unknown, minimum: number, fallback: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum ? value : fallback

/** The server's `inbox.keepRead`, whole minutes a read finish stays listed, in milliseconds. */
export const keepRead = (value: unknown) => countOption(inboxOption(value).keepRead, 0, 10) * 60_000

export function trackedSession(info: SessionInfo): TrackedSession {
  return {
    id: info.id, directory: info.location.directory, title: info.title || "Untitled session", updated: info.time.updated,
    archived: info.time.archived !== undefined, ...(info.parentID ? { parentID: info.parentID } : {}),
    ...(info.time.idle !== undefined ? { idle: info.time.idle } : {}), ...(info.time.viewed !== undefined ? { viewed: info.time.viewed } : {}),
    ...(info.outcome ? { outcome: info.outcome } : {}),
  }
}

/** The root of a known chain, or undefined while an ancestor's metadata is missing. */
export function rootOf(projection: Projection, sessionID: string) {
  const seen = new Set<string>()
  let session = projection.sessions[sessionID]
  while (session?.parentID && !seen.has(session.id)) {
    seen.add(session.id)
    session = projection.sessions[session.parentID]
  }
  return session && !session.parentID ? session : undefined
}

/** The first session in a status or request chain whose metadata still has to be fetched. */
export function missingSessions(projection: Projection) {
  const missing = new Set<string>()
  for (const id of [...Object.keys(projection.status), ...Object.values(projection.requests)]) {
    let current: string | undefined = id
    const seen = new Set<string>()
    while (current && !seen.has(current)) {
      seen.add(current)
      const session: TrackedSession | undefined = projection.sessions[current]
      if (!session) { missing.add(current); break }
      current = session.parentID
    }
  }
  return [...missing]
}

/** Finished or failed until the root's latest idle has been viewed. Subagents are almost never viewed, so only roots count. */
const unseen = (root: TrackedSession) => root.idle !== undefined && (root.viewed === undefined || root.idle > root.viewed)

export function activeRoots(projection: Projection, lingering?: Lingering): ActiveRoot[] {
  /** Its latest idle was read recently enough to stay listed. */
  const recent = (root: TrackedSession) => {
    if (!lingering) return false
    const read = lingering.reads[root.id]
    return !!read && read.idle === root.idle && lingering.now < read.at + lingering.keep
  }
  const families = new Map<string, { root: TrackedSession; needs: boolean; retry: boolean; busy: boolean; agents: number; since: number }>()
  const family = (sessionID: string) => {
    const root = rootOf(projection, sessionID)
    if (!root || root.archived) return
    let value = families.get(root.id)
    if (!value) families.set(root.id, value = { root, needs: false, retry: false, busy: false, agents: 0, since: root.updated })
    const session = projection.sessions[sessionID]
    if (session) value.since = Math.max(value.since, session.updated)
    return { root, value }
  }
  for (const [sessionID, status] of Object.entries(projection.status)) {
    const found = family(sessionID)
    if (!found) continue
    if (status === "action") found.value.needs = true
    else if (status === "retry") found.value.retry = true
    else found.value.busy = true
    if (found.root.id !== sessionID) found.value.agents++
  }
  for (const sessionID of Object.values(projection.requests)) {
    const found = family(sessionID)
    if (found) found.value.needs = true
  }
  for (const session of Object.values(projection.sessions)) if (!session.parentID && (unseen(session) || recent(session))) family(session.id)
  const result: ActiveRoot[] = []
  for (const { root, ...value } of families.values()) {
    const idle = !projection.status[root.id]
    const done = !value.needs && idle && (unseen(root) || recent(root))
    const state: AgentState | undefined = value.needs ? "needs-you"
      : done ? root.outcome === "failed" ? "failed" : "finished"
      : value.retry ? "retrying" : value.busy ? "working" : undefined
    if (!state) continue
    result.push({ id: root.id, state, read: done && !unseen(root), agents: value.agents, since: done ? root.idle! : value.since })
  }
  return result
}

/** Forgets sessions nothing lists or waits on, nor leads to one that does; they are read again if they become active. */
export function forgetInactive(projection: Projection, lingering?: Lingering) {
  const needed = new Set(activeRoots(projection, lingering).map((root) => root.id))
  for (const id of [...Object.keys(projection.status), ...Object.values(projection.requests)]) {
    for (let current: string | undefined = id; current && !needed.has(current); current = projection.sessions[current]?.parentID) needed.add(current)
  }
  for (const id of Object.keys(projection.sessions)) if (!needed.has(id)) delete projection.sessions[id]
}

/** Roots keep the order in which they became active; newly active ones follow, oldest activity first. */
export function reorder(previous: readonly string[], active: readonly ActiveRoot[]) {
  const ids = new Set(active.map((root) => root.id))
  const kept = previous.filter((id) => ids.has(id))
  const known = new Set(kept)
  return [...kept, ...active.filter((root) => !known.has(root.id)).sort((a, b) => a.since - b.since).map((root) => root.id)]
}

/** Event types that change the projection; everything else, including streaming deltas, is ignored cheaply. Keep in step with applyEvent. */
export const INBOX_EVENTS = new Set<OpenCodeEvent["type"]>([
  "session.created", "session.renamed", "session.moved", "session.archived", "session.unarchived", "session.deleted",
  "session.status", "session.idle", "session.viewed", "session.execution.started", "session.execution.succeeded",
  "session.execution.failed", "session.execution.interrupted", "permission.asked", "permission.replied",
  "form.created", "form.replied", "form.cancelled", "location.shutdown",
])

/** Apply one live event to a mutable projection (a store draft or a plain object). */
export function applyEvent(projection: Projection, event: OpenCodeEvent) {
  const touch = (sessionID: string) => {
    const session = projection.sessions[sessionID]
    if (session && "created" in event) session.updated = Math.max(session.updated, event.created)
    return session
  }
  const forget = (prefix: string, id: string) => { delete projection.requests[`${prefix}:${id}`] }
  switch (event.type) {
    case "session.created": {
      const { data } = event
      projection.sessions[data.sessionID] = {
        id: data.sessionID, directory: data.location.directory, title: data.title || "Untitled session", updated: event.created,
        archived: false, ...(data.parentID ? { parentID: data.parentID } : {}),
      }
      return
    }
    case "session.renamed": { const session = touch(event.data.sessionID); if (session) session.title = event.data.title; return }
    case "session.moved": { const session = touch(event.data.sessionID); if (session) session.directory = event.data.location.directory; return }
    case "session.archived": { const session = touch(event.data.sessionID); if (session) session.archived = true; return }
    case "session.unarchived": { const session = touch(event.data.sessionID); if (session) session.archived = false; return }
    case "session.deleted": {
      delete projection.sessions[event.data.sessionID]
      delete projection.status[event.data.sessionID]
      for (const [key, sessionID] of Object.entries(projection.requests)) if (sessionID === event.data.sessionID) delete projection.requests[key]
      return
    }
    case "session.status": {
      const { sessionID, status } = event.data
      touch(sessionID)
      if (status.type === "idle") delete projection.status[sessionID]
      else projection.status[sessionID] = status.type === "busy" ? "busy" : status.action ? "action" : "retry"
      return
    }
    case "session.idle": {
      delete projection.status[event.data.sessionID]
      const session = touch(event.data.sessionID)
      if (session) session.idle = event.created
      return
    }
    case "session.viewed": {
      // The host reports the idle time it showed; adopting it avoids comparing two clocks.
      const session = touch(event.data.sessionID)
      if (session) session.idle = session.viewed = event.data.idle
      return
    }
    case "session.execution.started": { const session = touch(event.data.sessionID); if (session) delete session.outcome; return }
    case "session.execution.succeeded": { const session = touch(event.data.sessionID); if (session) session.outcome = "succeeded"; return }
    case "session.execution.failed": { const session = touch(event.data.sessionID); if (session) session.outcome = "failed"; return }
    case "session.execution.interrupted": { const session = touch(event.data.sessionID); if (session) session.outcome = "interrupted"; return }
    case "permission.asked": touch(event.data.sessionID); projection.requests[`permission:${event.data.id}`] = event.data.sessionID; return
    case "permission.replied": forget("permission", event.data.requestID); return
    case "form.created": touch(event.data.form.sessionID); projection.requests[`form:${event.data.form.id}`] = event.data.form.sessionID; return
    case "form.replied": case "form.cancelled": forget("form", event.data.id); return
    case "location.shutdown": {
      const directory = event.location?.directory
      if (!directory) return
      const stopped = new Set(Object.values(projection.sessions).filter((session) => session.directory === directory).map((session) => session.id))
      for (const sessionID of Object.keys(projection.status)) if (stopped.has(sessionID)) delete projection.status[sessionID]
      for (const [key, sessionID] of Object.entries(projection.requests)) if (stopped.has(sessionID)) delete projection.requests[key]
      return
    }
  }
}

/**
 * What a terminal read of the host's running sessions and pending requests, which a server plugin can't read itself.
 * `listed` are the directories whose requests were read.
 */
export interface Observation { running: string[]; requests: Record<string, string>; listed: string[] }

/**
 * The status entries (session IDs) and requests (their keys) an event decides. Call it before applying the event, so the
 * requests it removes are known.
 */
export function decidedBy(projection: Projection, event: OpenCodeEvent): string[] {
  const requestsOf = (sessions: Set<string>) => Object.entries(projection.requests).filter(([, sessionID]) => sessions.has(sessionID)).map(([key]) => key)
  switch (event.type) {
    case "session.status": case "session.idle": return [event.data.sessionID]
    case "session.deleted": return [event.data.sessionID, ...requestsOf(new Set([event.data.sessionID]))]
    case "permission.asked": return [`permission:${event.data.id}`]
    case "permission.replied": return [`permission:${event.data.requestID}`]
    case "form.created": return [`form:${event.data.form.id}`]
    case "form.replied": case "form.cancelled": return [`form:${event.data.id}`]
    case "location.shutdown": {
      const directory = event.location?.directory
      const stopped = new Set(Object.values(projection.sessions).filter((session) => session.directory === directory).map((session) => session.id))
      return directory ? [...stopped, ...requestsOf(stopped)] : []
    }
    default: return []
  }
}

/**
 * Corrects status and requests by an observation, except where an event since decided them: those are newer. A running
 * session keeps a retry status; one that isn't running is idle. A request missing from the observation is gone once its
 * session isn't running, or its directory was listed.
 */
export function applyObservation(projection: Projection, observation: Observation, decided: (key: string) => boolean) {
  const running = new Set(observation.running)
  for (const sessionID of Object.keys(projection.status)) if (!running.has(sessionID) && !decided(sessionID)) delete projection.status[sessionID]
  for (const sessionID of running) if (!projection.status[sessionID] && !decided(sessionID)) projection.status[sessionID] = "busy"
  const listed = new Set(observation.listed)
  for (const [key, sessionID] of Object.entries(projection.requests)) {
    if (key in observation.requests || decided(key)) continue
    const directory = projection.sessions[sessionID]?.directory
    if (!running.has(sessionID) || (directory !== undefined && listed.has(directory))) delete projection.requests[key]
  }
  for (const [key, sessionID] of Object.entries(observation.requests)) if (!decided(key)) projection.requests[key] = sessionID
}

/** Where plugin navigation came from. The back row only shows on the session this plugin last opened. */
export interface History {
  stack: { id: string; title: string }[]
  target?: string
}

/** From anywhere but a session, such as home, the trail starts over. */
export function pushHistory(history: History, from: { id: string; title: string } | undefined, to: string): History {
  if (from?.id === to) return history
  return { stack: from ? [...history.stack, from] : [], target: to }
}

export function popHistory(history: History): { to?: string; history: History } {
  const to = history.stack.at(-1)
  return to ? { to: to.id, history: { stack: history.stack.slice(0, -1), target: to.id } } : { history }
}

/** Any other way of reaching a session or home forgets the trail; plugin pages, such as the session browser, keep it. */
export function observeRoute(history: History, type: "home" | "session" | "plugin", sessionID?: string): History {
  if (type === "plugin" || (type === "session" && sessionID === history.target)) return history
  return history.stack.length || history.target ? { stack: [] } : history
}

export function backEntry(history: History, currentSessionID: string | undefined) {
  return currentSessionID === history.target ? history.stack.at(-1) : undefined
}
