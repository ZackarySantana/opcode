import { afterEach, expect, test } from "bun:test"
import { closeServers, eventually, fakeServer, stopped } from "@opcode/core/test-support/server"
import { createRemote, FeedsClient, type Remote } from "../src/client"
import { serverPlugin } from "../src/index"
import { defaultSettings, type FeedsState } from "../src/model"
import { FeedRpc } from "../src/rpc"
import { npm, remote, rss } from "./host"

afterEach(closeServers)

const clients = new Set<FeedsClient>()
afterEach(() => { for (const client of clients) client.dispose(); clients.clear() })
const follow = (remote: Remote) => {
  const client = new FeedsClient(remote, stopped)
  clients.add(client)
  client.start()
  return client
}

test("terminals show each other's subscriptions and settings, and catch up on a change they missed while disconnected", async () => {
  const server = fakeServer({ plugin: serverPlugin(async () => rss, { timer: stopped }) })
  const first = follow(remote(server, "/home/me"))
  const second = follow(remote(server, "/work/web"))
  first.subscribe(npm, "status")
  await eventually(() => expect(second.timeline("feed", npm).recent.map((entry) => entry.title)).toContain("Elevated errors & latency"))
  expect(second.title(npm)).toBe("npm")
  first.updateSettings({ windowHours: 6 })
  await eventually(() => expect(second.settings().windowHours).toBe(6))

  // The change while disconnected is never delivered; reconnecting reads it.
  server.disconnect()
  first.unsubscribe(npm)
  await eventually(() => expect(second.subscriptions()).toEqual([]))
})

/** A server whose answers the test gives, call by call. */
function scriptedRemote(initial: FeedsState) {
  const calls: { method: string; input: unknown; answer: ReturnType<typeof Promise.withResolvers<FeedsState>> }[] = []
  const answer = (method: string, input: unknown) => {
    const answer = Promise.withResolvers<FeedsState>()
    calls.push({ method, input, answer })
    return answer.promise
  }
  const scripted: { calls: typeof calls; reads: number; latest: FeedsState; remote: Remote } = {
    calls,
    /** How many times the state was read. */
    reads: 0,
    /** What reads return. */
    latest: initial,
    remote: {
      state: async () => { scripted.reads++; return scripted.latest },
      update: (change) => answer("update", change),
      subscribe: (url, kind) => answer("subscribe", { url, kind }),
      unsubscribe: (url) => answer("unsubscribe", url),
      refresh: async () => scripted.latest,
      changes: () => ({ async *[Symbol.asyncIterator]() {} }),
    },
  }
  return scripted
}

const state = (revision: number, rest: Partial<FeedsState> = {}): FeedsState =>
  ({ server: "a", started: 1, revision, settings: defaultSettings, subscriptions: [], results: {}, ...rest })

test("subscribing, unsubscribing, and settings show at once and build on each other; a refused one is undone and explained", async () => {
  const scripted = scriptedRemote(state(1))
  const client = follow(scripted.remote)
  await eventually(() => expect(scripted.reads).toBe(1))
  // Space twice on a feed: subscribed, then not, before the server has answered either.
  client.toggle(npm, "status")
  expect(client.subscriptions()).toMatchObject([{ url: npm, kind: "status" }])
  client.toggle(npm, "status")
  expect(client.subscriptions()).toEqual([])
  client.updateSettings({ resolved: "both" })
  expect(client.settings().resolved).toBe("both")

  // Sent one at a time, in order.
  await eventually(() => expect(scripted.calls).toHaveLength(1))
  const subscribed = state(2, { subscriptions: [{ url: npm, kind: "status", createdAt: 1 }] })
  scripted.calls[0]!.answer.resolve(subscribed)
  await eventually(() => expect(scripted.calls).toHaveLength(2))
  expect(client.subscriptions()).toEqual([])
  scripted.calls[1]!.answer.reject({ type: "failed", message: "disk full" })
  scripted.latest = subscribed
  await eventually(() => expect(client.error()).toBe("disk full"))
  expect(client.subscriptions()).toMatchObject([{ url: npm }])
  expect(scripted.calls.map((call) => [call.method, call.input])).toEqual([
    ["subscribe", { url: npm, kind: "status" }], ["unsubscribe", npm], ["update", { resolved: "both" }],
  ])
})

test("a terminal says what to do when the server doesn't run the plugin", async () => {
  const client = follow({ ...scriptedRemote(state(1)).remote, state: async () => { throw { type: "rpc.unavailable", message: "no" } } })
  await eventually(() => expect(client.error()).toBe("The OpenCode server isn't running Feed: add @lidtop/opencode-feed to the server's plugins."))
})

test("the server's unreadable saved feeds show as the problem", async () => {
  const client = follow(scriptedRemote(state(1, { error: "The saved feeds can't be read right now: disk read failed" })).remote)
  await eventually(() => expect(client.error()).toBe("The saved feeds can't be read right now: disk read failed"))
})

test("calls go to the terminal's current location, through the client of the moment", async () => {
  const calls: { client: number; method: string; input: unknown; location: unknown }[] = []
  let current = 0
  let directory = "/home/me"
  const makeClient = (id: number) => ({
    rpc: (definition: typeof FeedRpc) => {
      expect(definition).toBe(FeedRpc)
      const method = (name: string) => async (input: unknown, options: { location: unknown }) => {
        calls.push({ client: id, method: name, input, location: options.location })
        return state(1)
      }
      return {
        state: method("state"), update: method("update"), subscribe: method("subscribe"), unsubscribe: method("unsubscribe"), refresh: method("refresh"),
        events: { subscribe: (name: string) => {
          expect(name).toBe("changed")
          return (async function* () { yield { type: "rpc.opcode-feed.changed", location: { directory: "/x" }, data: state(9) } })()
        } },
      }
    },
  })
  const clientsByID = [makeClient(0), makeClient(1)]
  const remote = createRemote(() => clientsByID[current] as never, () => ({ directory }))
  await remote.state()
  current = 1
  directory = "/work/web"
  await remote.update({ windowHours: 6 })
  await remote.subscribe(npm, "release")
  await remote.unsubscribe(npm)
  await remote.refresh()
  const at = (client: number, method: string, input: unknown) => ({ client, method, input, location: { directory: client ? "/work/web" : "/home/me" } })
  expect(calls).toEqual([
    at(0, "state", {}), at(1, "update", { settings: { windowHours: 6 } }), at(1, "subscribe", { url: npm, kind: "release" }),
    at(1, "unsubscribe", { url: npm }), at(1, "refresh", {}),
  ])
  const received: FeedsState[] = []
  for await (const changed of remote.changes(new AbortController().signal)) received.push(changed)
  expect(received).toEqual([state(9)])
})
