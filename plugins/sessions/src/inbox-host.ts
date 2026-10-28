import type { OpenCodeClient } from "@opencode/client"
import type { AttentionSoundName, Context, ToastVariant } from "@opencode/plugin/tui/context"
import { followState } from "@opcode/core/follow"
import { consumeLive } from "@opcode/core/live"
import { describeRpcError } from "@opcode/core/rpc"
import { createEffect, createMemo, createSignal, untrack } from "solid-js"
import type { AgentsState, Attention, AttentionKind } from "./agents"
import { backEntry, countOption, inboxOption, observeRoute, popHistory, pushHistory, type AgentRow, type History, type Observation } from "./inbox"
import type { AgentsRemote } from "./rpc"

/** The terminal's `inbox` options; the server has its own, `keepRead`. */
export interface InboxOptions { rows: number; notify: boolean }
export type Inbox = ReturnType<typeof createInbox>

/** `inbox` plugin options; undefined when disabled. */
export function inboxOptions(value: unknown): InboxOptions | undefined {
  const options = inboxOption(value)
  if (options.enabled === false) return
  return { rows: countOption(options.rows, 1, 5), notify: options.notify === true }
}

const alerts: Record<AttentionKind, { message: string; sound: AttentionSoundName; variant: ToastVariant }> = {
  permission: { message: "Waiting for your permission", sound: "permission", variant: "warning" },
  form: { message: "Waiting for your answer", sound: "question", variant: "warning" },
  finished: { message: "Finished", sound: "done", variant: "success" },
  failed: { message: "Failed", sound: "error", variant: "error" },
}

const describe = (error: unknown) => describeRpcError(error, { name: "Sessions", package: "@lidtop/opencode-sessions" })

/**
 * What the server asks terminals for, since its plugin API can't read it: the host's running sessions, and the requests
 * pending in their locations. A location that can't be listed, such as one shutting down, is left out of `listed`.
 */
export async function observeHost(client: Pick<OpenCodeClient, "session" | "permission" | "form">, signal: AbortSignal): Promise<Observation> {
  const running = Object.keys(await client.session.active({ signal }))
  const sessions = await Promise.allSettled(running.map((sessionID) => client.session.get({ sessionID }, { signal })))
  const directories = new Set(sessions.flatMap((result) => result.status === "fulfilled" ? [result.value.location.directory] : []))
  const requests: Record<string, string> = {}
  const listed: string[] = []
  await Promise.allSettled([...directories].map(async (directory) => {
    const [permissions, forms] = await Promise.all([
      client.permission.request.list({ location: { directory } }, { signal }),
      client.form.list({ location: { directory } }, { signal }),
    ])
    for (const request of permissions.data) requests[`permission:${request.id}`] = request.sessionID
    for (const form of forms.data) requests[`form:${form.id}`] = form.sessionID
    listed.push(directory)
  }))
  signal.throwIfAborted()
  return { running, requests, listed }
}

/**
 * The server's Agents list, followed live, with what stays with this terminal: the session you're in left out, alerts,
 * and plugin navigation with a back trail.
 */
export function createInbox(api: Context, options: InboxOptions, remote: AgentsRemote) {
  const lifetime = new AbortController()
  const [state, setState] = createSignal<AgentsState>()
  const [problem, setProblem] = createSignal<string>()
  const [history, setHistory] = api.storage.memory<History>("inbox-history", { initial: { stack: [] } })
  const saveHistory = (next: History) => setHistory((draft) => {
    draft.stack = [...next.stack]
    draft.target = next.target
  })

  const currentSession = () => { const route = api.ui.router.current(); return route.type === "session" ? route.sessionID : undefined }
  const currentRoot = createMemo(() => { const id = currentSession(); return id && api.data.session.root(id) })
  // The session you're in isn't listed: the list is where else you could go.
  const rows = createMemo<AgentRow[]>(() => (state()?.rows ?? []).filter((row) => row.id !== currentRoot()))
  const titleOf = (sessionID: string, fallback: string) =>
    state()?.rows.find((row) => row.id === sessionID)?.title ?? api.data.session.get(sessionID)?.title ?? fallback

  // The observation asked for, once per request; a failed one is tried again with the next state.
  let observing: string | undefined
  const observe = (asked: AgentsState) => {
    const key = asked.observe === undefined ? undefined : `${asked.server}:${asked.observe}`
    if (!key || key === observing) return
    observing = key
    void observeHost(api.client, lifetime.signal)
      .then((observation) => remote.observe({ server: asked.server, since: asked.revision, ...observation }, lifetime.signal))
      .then(follower.offer, () => { if (observing === key) observing = undefined })
  }
  const follower = followState<AgentsState>({
    read: (signal) => remote.state(signal),
    changes: (signal) => remote.changes(signal),
    apply: (next) => { setState(next); observe(next) },
    problem: setProblem,
    describe,
  })
  follower.start()

  // Each terminal alerts for what the server announces, except in the session family you're in.
  const notify = (attention: Attention) => {
    const root = attention.root ?? api.data.session.root(attention.sessionID)
    if (root === currentRoot()) return
    const alert = alerts[attention.kind]
    void api.attention.notify({
      title: attention.title ?? titleOf(root, "A session"), message: alert.message,
      notification: { when: "blurred" }, sound: { name: alert.sound, when: "blurred" },
    }).catch(() => {})
    api.ui.toast.show({ message: alert.message, variant: alert.variant, sessionID: root })
  }
  if (options.notify) void consumeLive({ signal: lifetime.signal, subscribe: (signal) => remote.attention(signal), handle: notify, warn: () => {} })

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
    error: () => problem() ?? state()?.error,
    /** The session the back row returns to, while on the session this plugin last opened. */
    back: () => backEntry(history, currentSession()),
    /** Navigate, remembering the session it came from. */
    open(sessionID: string) {
      const from = api.ui.router.current()
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
    dispose() {
      lifetime.abort()
      follower.dispose()
    },
  }
}
