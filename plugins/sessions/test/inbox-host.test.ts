import { expect, test } from "bun:test"
import type { OpenCodeEvent, SessionInfo } from "@opencode/client"
import type { AttentionNotifyOptions, Context, Destination, Route, ToastOptions } from "@opencode/plugin/tui/context"
import { createRoot, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createInbox, inboxOptions, type InboxOptions } from "../src/inbox-host"
import { session } from "./fixtures"

const event = (type: string, data: object, created = Date.now()) => ({ type, data, created }) as unknown as OpenCodeEvent

function fixture(sessions: SessionInfo[], options: Partial<InboxOptions> & { running?: string[]; permissions?: Record<string, string[]> } = {}) {
  const queue: OpenCodeEvent[] = []
  let wake = () => {}
  const push = (...events: OpenCodeEvent[]) => { queue.push(...events); wake() }
  const gate = { list: Promise.resolve(), started: Promise.withResolvers<void>() }
  const find = (id: string) => sessions.find((info) => info.id === id)
  const client = {
    session: {
      active: async () => (gate.started.resolve(), Object.fromEntries((options.running ?? []).map((id) => [id, { type: "running" }]))),
      list: async () => { await gate.list; return { data: sessions.filter((info) => !info.parentID), cursor: {} } },
      get: async ({ sessionID }: { sessionID: string }) => find(sessionID) ?? Promise.reject(new Error("not found")),
    },
    permission: { request: { list: async ({ location }: { location: { directory: string } }) => ({ location, data: (options.permissions?.[location.directory] ?? []).map((sessionID, index) => ({ id: `per_${index}`, sessionID, action: "bash", resources: [] })) }) } },
    form: { list: async ({ location }: { location: { directory: string } }) => ({ location, data: [] }) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      while (!signal.aborted) {
        const next = queue.shift()
        if (next) yield next
        else await new Promise<void>((resolve) => { wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }) })
      }
    } },
  }
  const [route, setRoute] = createSignal<Route>({ type: "session", sessionID: "elsewhere" })
  const notified: AttentionNotifyOptions[] = []
  const toasts: ToastOptions[] = []
  const api = {
    client,
    data: { session: { root: (id: string) => find(id)?.parentID ?? id, get: find } },
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
  const { inbox, dispose } = createRoot((dispose) => ({ inbox: createInbox(api, { rows: 5, notify: false, keepRead: 10, ...options }), dispose }))
  const settle = async (check: () => boolean, attempts = 100) => {
    for (let attempt = 0; attempt < attempts && !check(); attempt++) await Bun.sleep(1)
    expect(check()).toBe(true)
  }
  return { inbox, push, queue, gate, route, setRoute, notified, toasts, settle, [Symbol.dispose]() { inbox.dispose(); dispose() } }
}

const ids = (inbox: { rows(): { id: string; state: string }[] }) => inbox.rows().map(({ id, state }) => `${id}:${state}`)

test("the snapshot finds running subagents' roots in other locations and their requests, replays events that raced it, and live events fetch unknown sessions", async () => {
  const sessions = [
    session("seen", "/work/alpha"), session("root", "/work/beta"), { ...session("child", "/work/beta"), parentID: "root" },
    { ...session("unseen", "/work/gamma"), time: { created: 1, updated: 5, idle: 5 } },
  ]
  const list = Promise.withResolvers<void>()
  // Read finishes drop out at once.
  using ui = fixture(sessions, { keepRead: 0, running: ["child", "seen"], permissions: { "/work/beta": ["child"] } })
  ui.gate.list = list.promise
  ui.push(event("server.connected", {}))
  await ui.gate.started.promise
  // Finishes and is viewed while the snapshot still reads its running state.
  ui.push(event("session.status", { sessionID: "seen", status: { type: "idle" } }), event("session.idle", { sessionID: "seen" }, 6), event("session.viewed", { sessionID: "seen", idle: 6 }))
  await ui.settle(() => !ui.queue.length)
  list.resolve()
  await ui.settle(() => ids(ui.inbox).length === 2)
  expect(ids(ui.inbox)).toEqual(["unseen:finished", "root:needs-you"])
  expect(ui.inbox.rows()[1]).toMatchObject({ agents: 1, directory: "/work/beta" })

  // A subagent of a root the snapshot didn't read starts working.
  sessions.push(session("old", "/work/delta"), { ...session("old-child", "/work/delta"), parentID: "old" })
  ui.push(event("session.status", { sessionID: "old-child", status: { type: "busy" } }))
  await ui.settle(() => ids(ui.inbox).length === 3)
  expect(ids(ui.inbox)[2]).toBe("old:working")

  // The session you're in isn't listed, even when you're in one of its subagents.
  ui.setRoute({ type: "session", sessionID: "child" })
  expect(ids(ui.inbox)).toEqual(["unseen:finished", "old:working"])
})

test("a read finish stays listed in its place, across a reconnect, until its time is up", async () => {
  const finished = (id: string, idle: number): SessionInfo => ({ ...session(id), time: { created: 1, updated: idle, idle } })
  const sessions = [finished("first", 5), finished("second", 6)]
  using ui = fixture(sessions, { keepRead: 1 })
  ui.push(event("server.connected", {}))
  await ui.settle(() => ids(ui.inbox).length === 2)

  // Read almost a minute ago, in another terminal.
  ui.push(event("session.viewed", { sessionID: "first", idle: 5 }, Date.now() - 60_000 + 400))
  await ui.settle(() => ui.inbox.rows()[0]?.read === true)
  expect(ids(ui.inbox)).toEqual(["first:finished", "second:finished"])

  // The snapshot only says it was viewed; the read time survives it.
  sessions[0] = { ...finished("first", 5), time: { created: 1, updated: 5, idle: 5, viewed: 5 } }
  sessions.push(finished("third", 7))
  ui.push(event("server.connected", {}))
  await ui.settle(() => ids(ui.inbox).length === 3)
  expect(ui.inbox.rows().map((row) => [row.id, row.read])).toEqual([["first", true], ["second", false], ["third", false]])

  await ui.settle(() => ids(ui.inbox).length === 2, 2_000)
  expect(ids(ui.inbox)).toEqual(["second:finished", "third:finished"])
})

test("notifications: one per new request or finish outside the current family", async () => {
  const sessions = [session("current", "/work/alpha"), session("other", "/work/beta")]
  using ui = fixture(sessions, { notify: true, running: ["current", "other"] })
  ui.setRoute({ type: "session", sessionID: "current" })
  ui.push(event("server.connected", {}))
  await ui.settle(() => ui.inbox.rows().length === 1)
  ui.push(
    event("permission.asked", { id: "per_1", sessionID: "current", action: "bash", resources: [] }),
    event("permission.asked", { id: "per_2", sessionID: "other", action: "bash", resources: [] }),
    event("session.idle", { sessionID: "current" }),
    event("permission.replied", { sessionID: "other", requestID: "per_2", reply: "once" }),
    event("session.status", { sessionID: "other", status: { type: "idle" } }),
    event("session.idle", { sessionID: "other" }),
  )
  await ui.settle(() => ui.toasts.length === 2)
  expect(ui.toasts).toEqual([
    { message: "Waiting for your permission", variant: "warning", sessionID: "other" },
    { message: "Finished", variant: "success", sessionID: "other" },
  ])
  expect(ui.notified.map((value) => [value.title, value.message, value.notification])).toEqual([
    ["Session other", "Waiting for your permission", { when: "blurred" }],
    ["Session other", "Finished", { when: "blurred" }],
  ])
})

test("the back row follows plugin navigation and disappears once the user navigates another way", async () => {
  using ui = fixture([session("A"), session("B"), session("C"), session("D")])
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

test("options: enabled with five rows, reads kept ten minutes, and no notifications unless configured", () => {
  expect(inboxOptions(undefined)).toEqual({ rows: 5, notify: false, keepRead: 10 })
  expect(inboxOptions({ rows: 0, notify: "yes", keepRead: -1 })).toEqual({ rows: 5, notify: false, keepRead: 10 })
  expect(inboxOptions({ rows: 8, notify: true, keepRead: 0 })).toEqual({ rows: 8, notify: true, keepRead: 0 })
  expect(inboxOptions({ enabled: false })).toBeUndefined()
})
