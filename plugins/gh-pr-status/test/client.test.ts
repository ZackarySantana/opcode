import { afterEach, expect, test } from "bun:test"
import { closeServers, eventually, fakeServer, manualTimers, stopped } from "@opcode/core/test-support/server"
import { createRemote, PullRequestsClient, type Remote } from "../src/client"
import { serverPlugin } from "../src/index"
import { defaultSettings, type PullRequestsState, type SettingsChange } from "../src/model"
import { GhPrStatusRpc } from "../src/rpc"
import { ghRunner, remote } from "./host"

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
  const server = fakeServer({ plugin: serverPlugin(gh.run, stopped) })
  const first = follow(remote(server, "/home/me"))
  const second = follow(remote(server, "/work/web"))
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
