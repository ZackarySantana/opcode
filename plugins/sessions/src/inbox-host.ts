import type { OpenCodeEvent, SessionInfo } from "@opencode/client"
import type { AttentionSoundName, Context, Route, ToastVariant } from "@opencode/plugin/tui/context"
import { errorMessage } from "@opcode/core"
import { consumeLive } from "@opcode/core/live"
import { createEffect, createMemo, createSignal, untrack } from "solid-js"
import { createStore, produce } from "solid-js/store"
import {
  activeRoots, applyEvent, backEntry, emptyProjection, INBOX_EVENTS, missingSessions, observeRoute, popHistory, pushHistory,
  reorder, rootOf, trackedSession, type ActiveRoot, type History, type Projection,
} from "./inbox"

/** Newest roots read on each snapshot; older unseen ones only appear once they become active again. */
const SNAPSHOT_ROOTS = 100

export interface InboxOptions { rows: number; notify: boolean }
export interface InboxRow extends ActiveRoot { title: string; directory: string }
export type Inbox = ReturnType<typeof createInbox>

/** `inbox` plugin options; undefined when disabled. */
export function inboxOptions(value: unknown): InboxOptions | undefined {
  const options = value && typeof value === "object" ? value as Record<string, unknown> : {}
  if (options.enabled === false) return
  const rows = options.rows
  return { rows: typeof rows === "number" && Number.isInteger(rows) && rows > 0 ? rows : 5, notify: options.notify === true }
}

const alerts: Record<"permission" | "form" | "finished" | "failed", { message: string; sound: AttentionSoundName; variant: ToastVariant }> = {
  permission: { message: "Waiting for your permission", sound: "permission", variant: "warning" },
  form: { message: "Waiting for your answer", sound: "question", variant: "warning" },
  finished: { message: "Finished", sound: "done", variant: "success" },
  failed: { message: "Failed", sound: "error", variant: "error" },
}

/** Active root sessions across every location, kept current from a snapshot plus live events, and plugin navigation with a back trail. */
export function createInbox(api: Context, options: InboxOptions) {
  const client = api.client
  const lifetime = new AbortController()
  const [state, setState] = createStore<{ projection: Projection; order: string[] }>({ projection: emptyProjection(), order: [] })
  const [error, setError] = createSignal<string>()
  const [history, setHistory] = api.storage.memory<History>("inbox-history", { initial: { stack: [] } })
  const saveHistory = (next: History) => setHistory((draft) => {
    draft.stack = [...next.stack]
    draft.target = next.target
  })

  const currentSession = () => { const route = api.ui.router.current(); return route.type === "session" ? route.sessionID : undefined }
  const currentRoot = createMemo(() => { const id = currentSession(); return id && api.data.session.root(id) })
  const rows = createMemo<InboxRow[]>(() => {
    const active = new Map(activeRoots(state.projection).map((root) => [root.id, root]))
    return state.order.flatMap((id) => {
      const root = active.get(id)
      const session = state.projection.sessions[id]
      return root && session ? [{ ...root, title: session.title, directory: session.directory }] : []
    })
  })

  const titleOf = (sessionID: string, fallback: string) => state.projection.sessions[sessionID]?.title ?? api.data.session.get(sessionID)?.title ?? fallback
  const notify = (sessionID: string, kind: keyof typeof alerts) => {
    if (!options.notify) return
    const root = rootOf(state.projection, sessionID)?.id ?? api.data.session.root(sessionID)
    if (root === currentRoot()) return
    const alert = alerts[kind]
    void api.attention.notify({ title: titleOf(root, "A session"), message: alert.message, notification: { when: "blurred" }, sound: { name: alert.sound, when: "blurred" } }).catch(() => {})
    api.ui.toast.show({ message: alert.message, variant: alert.variant, sessionID: root })
  }

  /** Mutate, keep activation order, and fetch sessions the change refers to. */
  const update = (mutate: (projection: Projection) => void) => {
    setState(produce((draft) => {
      mutate(draft.projection)
      draft.order = reorder(draft.order, activeRoots(draft.projection))
    }))
    resolve()
  }

  // Status and requests can name sessions this projection has not read yet; their chains are fetched up to the root.
  const unavailable = new Set<string>()
  const fetchMissing = async (projection: () => Projection, add: (info: SessionInfo) => void, signal: AbortSignal) => {
    for (;;) {
      const ids = missingSessions(projection()).filter((id) => !unavailable.has(id))
      if (!ids.length) return
      await Promise.all(ids.map(async (sessionID) => {
        try { add(await client.session.get({ sessionID }, { signal })) } catch {
          signal.throwIfAborted()
          unavailable.add(sessionID)
        }
      }))
    }
  }
  let resolving: Promise<void> | undefined
  let again = false
  function resolve() {
    again = true
    resolving ??= (async () => {
      try {
        while (again && !lifetime.signal.aborted) {
          again = false
          await fetchMissing(() => state.projection, (info) => update((projection) => { projection.sessions[info.id] ??= trackedSession(info) }), lifetime.signal)
        }
      } catch { /* Disposed. */ } finally { resolving = undefined }
    })()
  }

  async function load(signal: AbortSignal) {
    const projection = emptyProjection()
    const [running, roots] = await Promise.all([
      client.session.active({ signal }),
      client.session.list({ parentID: null, archived: false, limit: SNAPSHOT_ROOTS }, { signal }),
    ])
    for (const info of roots.data) projection.sessions[info.id] = trackedSession(info)
    for (const sessionID of Object.keys(running)) projection.status[sessionID] = "busy"
    await fetchMissing(() => projection, (info) => { projection.sessions[info.id] = trackedSession(info) }, signal)
    // Requests are listed per location; only running sessions can be waiting on one. A location that shuts down meanwhile is skipped.
    const directories = new Set(Object.keys(projection.status).flatMap((sessionID) => projection.sessions[sessionID]?.directory ?? []))
    await Promise.allSettled([...directories].map(async (directory) => {
      const [permissions, forms] = await Promise.all([
        client.permission.request.list({ location: { directory } }, { signal }),
        client.form.list({ location: { directory } }, { signal }),
      ])
      for (const request of permissions.data) projection.requests[`permission:${request.id}`] = request.sessionID
      for (const form of forms.data) projection.requests[`form:${form.id}`] = form.sessionID
    }))
    signal.throwIfAborted()
    return projection
  }

  // Events received while a snapshot loads are replayed onto it; each event fully determines the fields it sets.
  // A reconnect during a load starts over: events from before it may have lost their follow-ups.
  let buffered: OpenCodeEvent[] | undefined
  let reload = false
  let loading: Promise<void> | undefined
  function snapshot() {
    reload = true
    loading ??= (async () => {
      let projection: Projection | undefined
      while (reload && !lifetime.signal.aborted) {
        reload = false
        buffered = []
        unavailable.clear()
        // A failed load keeps the live projection; a reconnect meanwhile still reloads.
        try { projection = await load(lifetime.signal); setError(undefined) } catch (error) {
          projection = undefined
          if (!lifetime.signal.aborted) setError(errorMessage(error))
        }
      }
      const replay = buffered ?? []
      buffered = loading = undefined
      if (projection && !lifetime.signal.aborted) update((draft) => {
        Object.assign(draft, projection)
        for (const event of replay) applyEvent(draft, event)
      })
    })()
  }

  void consumeLive<OpenCodeEvent>({
    signal: lifetime.signal,
    // Every (re)connection starts with server.connected, which reloads the snapshot.
    subscribe: (signal) => client.event.subscribe({ signal }),
    handle(event) {
      if (event.type === "server.connected") return snapshot()
      if (!INBOX_EVENTS.has(event.type)) return
      buffered?.push(event)
      update((projection) => applyEvent(projection, event))
      if (event.type === "permission.asked") notify(event.data.sessionID, "permission")
      if (event.type === "form.created") notify(event.data.form.sessionID, "form")
      if (event.type === "session.idle") {
        const state = rows().find((row) => row.id === event.data.sessionID)?.state
        if (state === "finished" || state === "failed") notify(event.data.sessionID, state)
      }
    },
    warn: () => {},
  })

  // Reaching a session any other way forgets the back trail.
  createEffect(() => {
    const route = api.ui.router.current()
    const sessionID = route.type === "session" ? route.sessionID : undefined
    // Only route changes count: saving a new target before navigating must not clear it.
    untrack(() => {
      const next = observeRoute(history, route.type, sessionID)
      if (next !== history) saveHistory(next)
    })
  })

  return {
    rows,
    error,
    currentRoot,
    /** The session the back row returns to, while on the session this plugin last opened. */
    back: () => backEntry(history, currentSession()),
    /** Navigate, remembering the session it came from. `from` is the session a plugin page was opened over. */
    open(sessionID: string, from: Route = api.ui.router.current()) {
      saveHistory(pushHistory(history, from.type === "session" ? { id: from.sessionID, title: titleOf(from.sessionID, "previous session") } : undefined, sessionID))
      api.ui.router.navigate({ type: "session", sessionID })
    },
    goBack() {
      const { to, history: next } = popHistory(history)
      if (!to) return false
      saveHistory(next)
      api.ui.router.navigate({ type: "session", sessionID: to })
      return true
    },
    dispose() { lifetime.abort() },
  }
}
