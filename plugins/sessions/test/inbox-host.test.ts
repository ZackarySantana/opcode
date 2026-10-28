import { afterEach, expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client"
import type { AttentionNotifyOptions, Context, Destination, Route, ToastOptions } from "@opencode/plugin/tui/context"
import { closeServers, eventually } from "@opcode/core/test-support/server"
import { createRoot, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createInbox, inboxOptions, type InboxOptions } from "../src/inbox-host"
import { agentsRemote, event, finished, host, sessionsServer } from "./agents-host"
import { session } from "./fixtures"

afterEach(closeServers)
const disposers = new Set<() => void>()
afterEach(() => { for (const dispose of disposers) dispose(); disposers.clear() })

/** A terminal in `directory`, following the server, whose host client reads `running` and `permissions` per location. */
function terminal(server: ReturnType<typeof sessionsServer>, sessions: SessionInfo[], options: Partial<InboxOptions> & { directory?: string; running?: string[]; permissions?: Record<string, string[]> } = {}) {
  const find = (id: string) => sessions.find((info) => info.id === id)
  const client = {
    session: {
      active: async () => Object.fromEntries((options.running ?? []).map((id) => [id, { type: "running" }])),
      get: async ({ sessionID }: { sessionID: string }) => find(sessionID) ?? Promise.reject(new Error("not found")),
    },
    permission: { request: { list: async ({ location }: { location: { directory: string } }) => ({ location, data: (options.permissions?.[location.directory] ?? []).map((sessionID, index) => ({ id: `per_${index}`, sessionID, action: "bash", resources: [] })) }) } },
    form: { list: async ({ location }: { location: { directory: string } }) => ({ location, data: [] }) },
  }
  const rootOf = (id: string): string => { const parent = find(id)?.parentID; return parent ? rootOf(parent) : id }
  const [route, setRoute] = createSignal<Route>({ type: "home" })
  const notified: AttentionNotifyOptions[] = []
  const toasts: ToastOptions[] = []
  const api = {
    client,
    data: { session: { root: rootOf, get: find } },
    attention: { notify: async (value: AttentionNotifyOptions) => { notified.push(value); return { ok: true, notification: true, sound: false } } },
    storage: { memory: <Value extends object>(_key: string, { initial }: { initial: Value }) => {
      const [store, set] = createStore(initial)
      return [store, (mutation: (draft: Value) => void) => set(produce(mutation))] as const
    } },
    ui: {
      router: { current: route, navigate: (next: Destination) => setRoute(next as Route) },
      toast: { show: (value: ToastOptions) => toasts.push(value) },
    },
  } as unknown as Context
  const { inbox, dispose } = createRoot((dispose) => ({ inbox: createInbox(api, { rows: 5, notify: false, ...options }, agentsRemote(server, options.directory)), dispose }))
  disposers.add(() => { inbox.dispose(); dispose() })
  return { inbox, route, setRoute, notified, toasts }
}

const ids = (inbox: { rows(): { id: string; state: string }[] }) => inbox.rows().map(({ id, state }) => `${id}:${state}`)

test("terminals show the same list in the same order, observe what runs when the server asks, and each leaves out the session it's in", async () => {
  const sessions = [finished("done", 5), session("root", "/work/beta"), { ...session("child", "/work/beta"), parentID: "root" }, session("other")]
  const opencode = host(sessions)
  const server = sessionsServer(opencode)
  const first = terminal(server, sessions, { running: ["child"], permissions: { "/work/beta": ["child"] } })
  const second = terminal(server, sessions, { directory: "/work/beta", running: ["child"], permissions: { "/work/beta": ["child"] } })
  await eventually(() => expect(ids(first.inbox)).toEqual(["done:finished", "root:needs-you"]))
  expect(first.inbox.rows()[1]).toMatchObject({ agents: 1, directory: "/work/beta", title: "Session root" })
  await eventually(() => expect(second.inbox.rows()).toEqual(first.inbox.rows()))

  opencode.emit(event("session.status", { sessionID: "other", status: { type: "busy" } }))
  await eventually(() => expect(ids(second.inbox)).toEqual(["done:finished", "root:needs-you", "other:working"]))
  // The session you're in isn't listed, even when you're in one of its subagents.
  second.setRoute({ type: "session", sessionID: "child" })
  expect(ids(second.inbox)).toEqual(["done:finished", "other:working"])
  expect(ids(first.inbox)).toEqual(["done:finished", "root:needs-you", "other:working"])

  // A change announced while disconnected is read on reconnecting.
  server.disconnect()
  opencode.emit(event("session.viewed", { sessionID: "done", idle: 5 }))
  await eventually(() => expect(first.inbox.rows()[0]).toMatchObject({ id: "done", read: true }))
})

test("alerts: each terminal alerts once per new request or finish, except in the session family it's in, and only when configured", async () => {
  const sessions = [session("root"), { ...session("child"), parentID: "root" }, session("other")]
  const opencode = host(sessions)
  const server = sessionsServer(opencode)
  const inRoot = terminal(server, sessions, { notify: true })
  const inOther = terminal(server, sessions, { notify: true })
  const quiet = terminal(server, sessions)
  inRoot.setRoute({ type: "session", sessionID: "child" })
  inOther.setRoute({ type: "session", sessionID: "other" })
  await eventually(() => expect(opencode.streams()).toHaveLength(2))
  // Its attention subscription is open once a change reaches it.
  opencode.emit(event("session.status", { sessionID: "child", status: { type: "busy" } }), event("session.status", { sessionID: "other", status: { type: "busy" } }))
  await eventually(() => expect(ids(quiet.inbox)).toEqual(["root:working", "other:working"]))

  opencode.emit(
    event("permission.asked", { id: "per_1", sessionID: "child", action: "bash", resources: [] }),
    event("session.status", { sessionID: "other", status: { type: "idle" } }),
    event("session.idle", { sessionID: "other" }),
  )
  await eventually(() => expect(inRoot.toasts.length + inOther.toasts.length).toBe(2))
  expect(inOther.toasts).toEqual([{ message: "Waiting for your permission", variant: "warning", sessionID: "root" }])
  expect(inRoot.toasts).toEqual([{ message: "Finished", variant: "success", sessionID: "other" }])
  expect(inRoot.notified.map((value) => [value.title, value.message, value.notification])).toEqual([["Session other", "Finished", { when: "blurred" }]])
  expect(quiet.toasts).toEqual([])
})

test("the back row follows plugin navigation and disappears once the user navigates another way", async () => {
  const sessions = [session("A"), session("B"), session("C"), session("D")]
  const ui = terminal(sessionsServer(host(sessions)), sessions)
  ui.setRoute({ type: "session", sessionID: "A" })
  ui.inbox.open("B")
  expect(ui.inbox.back()?.id).toBe("A")
  ui.inbox.open("C")
  expect(ui.inbox.back()?.id).toBe("B")
  expect(ui.inbox.goBack()).toBe(true)
  expect(ui.route()).toEqual({ type: "session", sessionID: "B" })
  expect(ui.inbox.back()).toEqual({ id: "A", title: "Session A" })
  ui.setRoute({ type: "session", sessionID: "D" })
  expect(ui.inbox.back()).toBeUndefined()
  ui.inbox.open("A")
  expect(ui.inbox.back()?.id).toBe("D")
  ui.setRoute({ type: "session", sessionID: "B" })
  ui.setRoute({ type: "session", sessionID: "A" })
  expect(ui.inbox.back()).toBeUndefined()
  expect(ui.inbox.goBack()).toBe(false)
})

test("terminal options: enabled with five rows, and no notifications unless configured", () => {
  expect(inboxOptions(undefined)).toEqual({ rows: 5, notify: false })
  expect(inboxOptions({ rows: 0, notify: "yes" })).toEqual({ rows: 5, notify: false })
  expect(inboxOptions({ rows: 8, notify: true })).toEqual({ rows: 8, notify: true })
  expect(inboxOptions({ enabled: false })).toBeUndefined()
})
