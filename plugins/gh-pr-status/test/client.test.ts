import { afterEach, expect, test } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import { createRemote, PullRequestsClient, type Remote } from "../src/client"
import { defaultSettings, type PullRequestsState, type SettingsChange } from "../src/model"
import { GhPrStatusRpc } from "../src/rpc"
import { closeServers, eventually, fakeServer, ghRunner, manualTimers, stopped } from "./host"

afterEach(closeServers)

const clients = new Set<PullRequestsClient>()
afterEach(() => { for (const client of clients) client.dispose(); clients.clear() })
const follow = (remote: Remote, timer = stopped) => {
  const client = new PullRequestsClient(remote, timer)
  clients.add(client)
  client.start()
  return client
}

test("terminals show each other's changes, and catch up on one they missed while disconnected", async () => {
  const gh = ghRunner()
  const server = fakeServer({ run: gh.run })
  const first = follow(server.remote("/home/me"))
  const second = follow(server.remote("/work/web"))
  await eventually(() => expect(second.snapshot()?.viewer).toBe("me"))
  expect(gh.searches).toHaveLength(1)

  first.updateSettings({ order: "newest" })
  await eventually(() => expect(second.settings().order).toBe("newest"))
  first.refresh()
  await eventually(() => expect(gh.searches).toHaveLength(2))
  await eventually(() => expect(second.refreshing()).toBe(false))

  // The change while disconnected is never delivered; reconnecting reads it.
  server.disconnect()
  first.updateSettings({ team: "acme/web" })
  await eventually(() => expect(second.settings().team).toBe("acme/web"))
})

/** A server whose answers and announcements the test makes. */
function scriptedRemote(initial: PullRequestsState) {
  const announce: ((state: PullRequestsState) => void)[] = []
  const scripted: {
    updates: { change: SettingsChange; answer: ReturnType<typeof Promise.withResolvers<PullRequestsState>> }[]
    reads: number
    latest: PullRequestsState
    nextRead: (() => Promise<PullRequestsState>) | undefined
    announce(state: PullRequestsState): void
    remote: Remote
  } = {
    /** Each update sent, with its answer to give. */
    updates: [],
    /** How many times the state was read. */
    reads: 0,
    /** What reads return. */
    latest: initial,
    /** Answers the next read instead, once. */
    nextRead: undefined,
    announce: (state: PullRequestsState) => announce.forEach((push) => push(state)),
    remote: {
      state: async () => {
        scripted.reads++
        const next: (() => Promise<PullRequestsState>) | undefined = scripted.nextRead
        scripted.nextRead = undefined
        return next ? await next() : scripted.latest
      },
      update: (change) => {
        const answer = Promise.withResolvers<PullRequestsState>()
        scripted.updates.push({ change, answer })
        return answer.promise
      },
      refresh: async () => scripted.latest,
      feedback: async () => ({ number: 1, summary: "" }),
      changes: (signal) => ({
        async *[Symbol.asyncIterator]() {
          const queue: PullRequestsState[] = []
          let wake = () => {}
          announce.push((state) => { queue.push(state); wake() })
          while (!signal.aborted) {
            if (queue.length) yield queue.shift()!
            else await new Promise<void>((resolve) => { wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }) })
          }
        },
      }),
    },
  }
  return scripted
}

const state = (server: string, started: number, revision: number, rest: Partial<Omit<PullRequestsState, "settings">> & { settings?: Partial<PullRequestsState["settings"]> } = {}): PullRequestsState =>
  ({ server, started, revision, refreshing: false, ...rest, settings: { ...defaultSettings, ...rest.settings } })

test("a terminal keeps the newest state through duplicates and late arrivals, and moves to a service started later", async () => {
  const scripted = scriptedRemote(state("a", 100, 1))
  const client = follow(scripted.remote)
  const orders: string[] = []
  createRoot(() => createComputed(() => { const order = client.settings().order; if (orders.at(-1) !== order) orders.push(order) }))
  await eventually(() => expect(scripted.reads).toBe(1))
  scripted.announce(state("a", 100, 3, { settings: { order: "oldest" } }))
  scripted.announce(state("a", 100, 2, { settings: { order: "newest" } }))
  // An older service, such as a previous version's still loaded somewhere, is not followed.
  scripted.announce(state("old", 50, 9, { settings: { order: "newest" } }))
  scripted.announce(state("a", 100, 3, { settings: { order: "oldest" } }))
  scripted.announce(state("b", 200, 0, { settings: { order: "smart", sidebarItems: 20 } }))
  await eventually(() => expect(client.settings().sidebarItems).toBe(20))
  expect(orders).toEqual(["smart", "oldest", "smart"])
})

test("the countdown counts the time left from when the state arrived, whatever the server's clock", async () => {
  const scripted = scriptedRemote(state("a", Date.now() + 86_400_000, 1, { nextRefreshIn: 90_000 }))
  const client = follow(scripted.remote)
  await eventually(() => expect(client.nextRefresh()).toBeDefined())
  expect(Math.abs(client.nextRefresh()! - (Date.now() + 90_000))).toBeLessThan(1_000)
})

test("a refresh long overdue reads the state again once, as the server may have stopped announcing", async () => {
  const timers = manualTimers()
  const scripted = scriptedRemote(state("a", 1, 1, { nextRefreshIn: -120_000 }))
  follow(scripted.remote, timers.timer)
  await eventually(() => expect(scripted.reads).toBe(1))
  timers.fire(60_000)
  await eventually(() => expect(scripted.reads).toBe(2))
  timers.fire(60_000)
  await Promise.resolve()
  expect(scripted.reads).toBe(2)
})

test("setting changes show at once and build on each other; one the server refuses is undone and explained", async () => {
  const scripted = scriptedRemote(state("a", 1, 1))
  const client = follow(scripted.remote)
  await eventually(() => expect(scripted.reads).toBe(1))
  client.updateSettings({ ignoreDays: 14 })
  client.updateSettings({ ignoreDays: 7, team: "acme/web" })
  expect(client.settings()).toEqual({ ...defaultSettings, ignoreDays: 7, team: "acme/web" })

  // Sent one at a time, in order; the answer to the first leaves the second showing.
  await eventually(() => expect(scripted.updates).toHaveLength(1))
  scripted.updates[0]!.answer.resolve(state("a", 1, 2, { settings: { ignoreDays: 14 } }))
  await eventually(() => expect(scripted.updates).toHaveLength(2))
  expect(client.settings()).toEqual({ ...defaultSettings, ignoreDays: 7, team: "acme/web" })
  scripted.updates[1]!.answer.reject({ type: "failed", message: "disk full" })
  await eventually(() => expect(client.error()).toBe("disk full"))
  expect(client.settings()).toEqual({ ...defaultSettings, ignoreDays: 14 })

  client.updateSettings({ team: "acme/web" })
  expect(client.settings().team).toBe("acme/web")
  client.updateSettings({ team: null })
  expect(client.settings().team).toBeUndefined()
})

test("a refused change shows the server's settings when the server moved on meanwhile", async () => {
  const scripted = scriptedRemote(state("a", 1, 1))
  const client = follow(scripted.remote)
  await eventually(() => expect(scripted.reads).toBe(1))
  client.updateSettings({ order: "oldest" })
  scripted.latest = state("a", 1, 5, { settings: { order: "newest", sidebarItems: 3 } })
  await eventually(() => expect(scripted.updates).toHaveLength(1))
  scripted.updates[0]!.answer.reject({ type: "failed", message: "disk full" })
  await eventually(() => expect(client.settings()).toEqual({ ...defaultSettings, order: "newest", sidebarItems: 3 }))
  expect(client.error()).toBe("disk full")
})

test("a terminal whose first read fails says why, and reads again later", async () => {
  const timers = manualTimers()
  const scripted = scriptedRemote(state("a", 1, 1, { snapshot: { viewer: "me", teams: [], mine: { prs: [], hidden: 0 }, requested: { prs: [], hidden: 0 }, reviewed: { prs: [], hidden: 0 } } }))
  scripted.nextRead = async () => { throw { type: "rpc.internal", message: "Server restarting" } }
  const client = follow(scripted.remote, timers.timer)
  await eventually(() => expect(client.error()).toBe("Server restarting"))
  expect(timers.pending(30_000)).toBe(1)
  timers.fire(30_000)
  await eventually(() => expect(client.snapshot()?.viewer).toBe("me"))
  expect(client.error()).toBeUndefined()
})

test("without the server plugin, a terminal says to add it", async () => {
  const scripted = scriptedRemote(state("a", 1, 1))
  scripted.nextRead = async () => { throw { type: "rpc.unavailable", message: "RPC opcode-gh-pr-status is not available" } }
  const client = follow(scripted.remote)
  await eventually(() => expect(client.error()).toBe("The OpenCode server isn't running GH PR Status: add @lidtop/opencode-gh-pr-status to the server's plugins."))
})

test("calls go to the terminal's current location, feedback to the session's, through the client of the moment", async () => {
  const calls: { client: number; method: string; input: unknown; location: unknown }[] = []
  let current = 0
  let directory = "/home/me"
  const makeClient = (id: number) => ({
    rpc: (definition: typeof GhPrStatusRpc) => {
      expect(definition).toBe(GhPrStatusRpc)
      const method = (name: string) => async (input: unknown, options: { location: unknown }) => {
        calls.push({ client: id, method: name, input, location: options.location })
        return name === "feedback" ? { number: 7, summary: "s" } : state("a", 1, 1)
      }
      return {
        state: method("state"), update: method("update"), refresh: method("refresh"), feedback: method("feedback"),
        events: { subscribe: (name: string) => {
          expect(name).toBe("changed")
          return (async function* () { yield { type: "rpc.opcode-gh-pr-status.changed", location: { directory: "/x" }, data: state("a", 1, 9) } })()
        } },
      }
    },
  })
  const clientsByID = [makeClient(0), makeClient(1)]
  const remote = createRemote(() => clientsByID[current] as never, () => ({ directory }))
  await remote.state()
  current = 1
  directory = "/work/web"
  await remote.update({ team: null })
  await remote.refresh()
  expect(await remote.feedback("/work/session", new AbortController().signal)).toEqual({ number: 7, summary: "s" })
  expect(calls).toEqual([
    { client: 0, method: "state", input: {}, location: { directory: "/home/me" } },
    { client: 1, method: "update", input: { settings: { team: null } }, location: { directory: "/work/web" } },
    { client: 1, method: "refresh", input: {}, location: { directory: "/work/web" } },
    { client: 1, method: "feedback", input: {}, location: { directory: "/work/session" } },
  ])
  const received: PullRequestsState[] = []
  for await (const changed of remote.changes(new AbortController().signal)) received.push(changed)
  expect(received).toEqual([state("a", 1, 9)])
})
