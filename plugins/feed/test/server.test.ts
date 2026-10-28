import { afterEach, expect, spyOn, test } from "bun:test"
import { createSerialQueue } from "@opcode/core"
import { closeServers, eventually, fakeServer, manualTimers, stopped, transported } from "@opcode/core/test-support/server"
import type { Fetcher } from "../src/fetch"
import { serverPlugin } from "../src/index"
import { defaultSettings, type FeedsState } from "../src/model"
import { FeedsService, type Ports, type StorageKey } from "../src/service"
import { npm, remote, rss } from "./host"

afterEach(closeServers)

const announced = (server: ReturnType<typeof fakeServer>) => server.events.map((event) => ({ directory: event.directory, state: event.data as FeedsState }))

/** A fetcher answering every feed with `rss`, counting fetches by URL. */
function counting(xml = rss) {
  const fetches: string[] = []
  const fetcher: Fetcher = async (url) => { fetches.push(url); return xml }
  return { fetcher, fetches }
}

test("every location shares one service: one fetch per feed, subscriptions and settings saved once for all", async () => {
  const feeds = counting()
  const server = fakeServer({ plugin: serverPlugin(feeds.fetcher, { timer: stopped }), stored: new Map<string, unknown>([["settings", { windowHours: 72 }]]) })
  const home = remote(server, "/home/me"), web = remote(server, "/work/web")
  expect((await home.state()).settings).toEqual({ ...defaultSettings, windowHours: 72 })

  const subscribed = await web.subscribe(npm, "status")
  expect(subscribed.subscriptions).toMatchObject([{ url: npm, kind: "status" }])
  // Subscribing again changes nothing.
  expect((await home.subscribe(npm, "release")).subscriptions).toMatchObject([{ url: npm, kind: "status" }])
  await eventually(async () => expect((await home.state()).results[npm]).toMatchObject({ status: "ok", feed: { title: "npm Status - Incident History" } }))
  expect(feeds.fetches).toEqual([npm])
  // Items arrive already read as their kind.
  expect((await home.state()).results[npm]).toMatchObject({ feed: { items: [{ phase: "resolved", status: "Resolved", title: "Elevated errors & latency" }, {}] } })
  // The feed's own title is saved with the subscription.
  await eventually(() => expect(server.stored.get("subscriptions")).toMatchObject([{ url: npm, kind: "status", title: "npm Status - Incident History" }]))

  await web.update({ sidebarItems: 10 })
  expect((await home.state()).settings).toEqual({ ...defaultSettings, windowHours: 72, sidebarItems: 10 })
  expect(server.stored.get("settings")).toEqual({ ...defaultSettings, windowHours: 72, sidebarItems: 10 })
  // A typed URL is checked on the server too.
  await expect(home.subscribe("file:///etc/passwd", "status")).rejects.toMatchObject({ type: "failed", message: "Feeds must use http or https" })

  // Once every location unloads the service stops; the next starts from what was saved, and fetches again.
  const before = await home.state()
  await server.close()
  const after = await home.state()
  expect(after.server).not.toBe(before.server)
  expect(after.subscriptions).toEqual([{ url: npm, kind: "status", title: "npm Status - Incident History", createdAt: expect.any(Number) }])
  expect(after.settings).toEqual({ ...defaultSettings, windowHours: 72, sidebarItems: 10 })
  await eventually(() => expect(feeds.fetches).toEqual([npm, npm]))
})

test("a refresh of many feeds is announced together, once for every location, not feed by feed", async () => {
  const urls = ["a", "b", "c", "d"].map((name) => `https://${name}.test/rss`)
  const server = fakeServer({
    plugin: serverPlugin(counting().fetcher, { timer: stopped }),
    stored: new Map<string, unknown>([["subscriptions", urls.map((url) => ({ url, kind: "status", createdAt: 0 }))]]),
  })
  const home = remote(server, "/home/me"), web = remote(server, "/work/web")
  await web.state()
  await eventually(async () => expect(Object.values((await home.state()).results).every((result) => result.status === "ok")).toBe(true))
  await Bun.sleep(150)
  const start = server.events.length
  await home.refresh()
  await eventually(() => expect(announced(server).at(-1)?.state.results).toMatchObject(Object.fromEntries(urls.map((url) => [url, { status: "ok" }]))))
  await Bun.sleep(150)
  expect(server.events.length - start).toBe(1)
  const revisions = announced(server).map((event) => event.state.revision)
  expect(new Set(revisions).size).toBe(revisions.length)
})

test("unreadable saved feeds aren't replaced: changes are refused until they can be read, which is tried again", async () => {
  const timers = manualTimers()
  const feeds = counting()
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const saved = [{ url: npm, kind: "status", createdAt: 1 }]
    const server = fakeServer({ plugin: serverPlugin(feeds.fetcher, { timer: timers.timer }), stored: new Map<string, unknown>([["subscriptions", saved]]) })
    server.faults.get = true
    const home = remote(server)
    const unread = await home.state()
    expect(unread.subscriptions).toEqual([])
    expect(unread.error).toContain("can't be read")
    await expect(home.subscribe("https://other.test/rss", "status")).rejects.toMatchObject({ type: "failed", message: expect.stringContaining("can't be changed") })
    await expect(home.update({ windowHours: 6 })).rejects.toMatchObject({ type: "failed" })
    expect(server.stored.get("subscriptions")).toEqual(saved)
    expect(server.stored.has("settings")).toBe(false)
    expect(feeds.fetches).toEqual([])

    // Read again on a timer, announced, and fetched.
    server.faults.get = false
    timers.fire(10_000)
    await eventually(() => expect(announced(server).at(-1)?.state).toMatchObject({ subscriptions: [{ url: npm }], results: { [npm]: { status: "ok" } } }))
    expect(announced(server).at(-1)?.state.error).toBeUndefined()
    expect(feeds.fetches).toEqual([npm])

    // A change that can't be saved fails with the reason and changes nothing.
    server.faults.set = true
    await expect(home.unsubscribe(npm)).rejects.toEqual({ type: "failed", message: "disk full" })
    expect((await home.state()).subscriptions).toMatchObject([{ url: npm }])
  } finally { warn.mockRestore() }
})

test("a change made while the saved feeds couldn't be read reads them first, and keeps them", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const server = fakeServer({ plugin: serverPlugin(counting().fetcher, { timer: stopped }), stored: new Map<string, unknown>([["subscriptions", [{ url: npm, kind: "status", createdAt: 1 }]]]) })
    server.faults.get = true
    const home = remote(server)
    await home.state()
    server.faults.get = false
    expect((await home.subscribe("https://other.test/rss", "release")).subscriptions.map((subscription) => subscription.url)).toEqual([npm, "https://other.test/rss"])
  } finally { warn.mockRestore() }
})

/** Plugin storage shared by services, slow enough that unserialized changes would overlap. */
function sharedStorage(stored: Map<string, unknown>): Ports {
  return {
    load: async (key: StorageKey) => { await Bun.sleep(1); return stored.has(key) ? transported(stored.get(key)) : undefined },
    save: async (key, value) => { await Bun.sleep(1); stored.set(key, transported(value)) },
    publish: async () => {},
  }
}

test("two versions' services running at once keep each other's changes", async () => {
  // During an upgrade each version runs its own service, and both share the writes.
  const stored = new Map<string, unknown>()
  const writes = createSerialQueue()
  const old = new FeedsService(sharedStorage(stored), writes, counting().fetcher, { timer: stopped })
  const current = new FeedsService(sharedStorage(stored), writes, counting().fetcher, { timer: stopped })
  try {
    await Promise.all([old.ready, current.ready])
    await Promise.all([old.subscribe("https://a.test/rss", "status"), current.subscribe("https://b.test/rss", "status"), old.update({ windowHours: 6 }), current.update({ sidebarItems: 3 })])
    expect(stored.get("subscriptions")).toMatchObject([{ url: "https://a.test/rss" }, { url: "https://b.test/rss" }])
    expect(stored.get("settings")).toEqual({ ...defaultSettings, windowHours: 6, sidebarItems: 3 })
    // Each shows the other's changes once it makes its own.
    expect((await old.unsubscribe("https://a.test/rss")).subscriptions.map((subscription) => subscription.url)).toEqual(["https://b.test/rss"])
  } finally {
    old.dispose()
    current.dispose()
  }
})

test("a failed fetch is retried within seconds before it shows as unreachable, then again on the refresh schedule", async () => {
  const timers = manualTimers()
  let calls = 0
  const fetcher: Fetcher = async () => { if (++calls <= 3) throw new Error("HTTP 503"); return rss }
  const server = fakeServer({ plugin: serverPlugin(fetcher, { timer: timers.timer }), stored: new Map<string, unknown>([["subscriptions", [{ url: npm, kind: "status", createdAt: 1 }]]]) })
  const home = remote(server)
  const result = async () => (await home.state()).results[npm]
  await home.state()
  await eventually(() => expect(calls).toBe(1))
  expect((await result())?.status).toBe("loading")
  timers.fire(2_000)
  await eventually(() => expect(calls).toBe(2))
  expect((await result())?.status).toBe("loading")
  timers.fire(5_000)
  await eventually(async () => expect(await result()).toEqual({ status: "error", error: "HTTP 503" }))
  expect(calls).toBe(3)
  timers.fire(10 * 60_000)
  await eventually(async () => expect((await result())?.status).toBe("ok"))

  // A later failure keeps the items beside the error.
  calls = 0
  await home.refresh()
  timers.fire(2_000)
  await eventually(() => expect(calls).toBe(2))
  timers.fire(5_000)
  await eventually(async () => expect(await result()).toMatchObject({ status: "error", error: "HTTP 503", feed: { items: [{ title: "Elevated errors & latency" }, {}] } }))
})

test("refreshes follow the interval setting; changing it or refreshing by hand restarts the countdown", async () => {
  const timers = manualTimers()
  const feeds = counting()
  const server = fakeServer({ plugin: serverPlugin(feeds.fetcher, { timer: timers.timer }), stored: new Map<string, unknown>([["subscriptions", [{ url: npm, kind: "status", createdAt: 1 }]]]) })
  const home = remote(server)
  const minutesLeft = (state: FeedsState) => Math.round(state.nextRefreshIn! / 60_000)
  expect(minutesLeft(await home.state())).toBe(10)
  await eventually(() => expect(feeds.fetches).toHaveLength(1))
  expect(minutesLeft(await home.update({ refreshMinutes: 5 }))).toBe(5)
  // The old schedule is gone.
  timers.fire(10 * 60_000)
  timers.fire(5 * 60_000)
  await eventually(() => expect(feeds.fetches).toHaveLength(2))
  // A refresh by hand replaces the pending automatic one rather than adding another.
  await home.refresh()
  expect(timers.pending(5 * 60_000)).toBe(1)
  timers.fire(5 * 60_000)
  await eventually(() => expect(feeds.fetches).toHaveLength(4))
})

test("a newer fetch of a feed wins over an older one that settles later, and an unsubscribed feed's late result is dropped", async () => {
  const calls: { url: string; resolve(xml: string): void; reject(error: Error): void }[] = []
  const fetcher: Fetcher = (url) => new Promise((resolve, reject) => calls.push({ url, resolve, reject }))
  const server = fakeServer({ plugin: serverPlugin(fetcher, { timer: stopped, retryDelays: [] }) })
  const home = remote(server)
  await home.subscribe(npm, "status")
  await home.refresh()
  calls[1]!.resolve(rss)
  await eventually(async () => expect((await home.state()).results[npm]?.status).toBe("ok"))
  calls[0]!.reject(new Error("The operation timed out."))
  await Bun.sleep(0)
  expect((await home.state()).results[npm]?.status).toBe("ok")

  await home.subscribe("https://slow.test/rss", "release")
  await home.unsubscribe("https://slow.test/rss")
  calls.find((call) => call.url === "https://slow.test/rss")!.resolve(rss)
  await Bun.sleep(0)
  const state = await home.state()
  expect(Object.keys(state.results)).toEqual([npm])
  expect(state.subscriptions.map((subscription) => subscription.url)).toEqual([npm])
})

test("a stopped service fetches and announces nothing more, and refuses changes", async () => {
  const published: FeedsState[] = []
  const feeds = counting()
  const ports: Ports = { ...sharedStorage(new Map()), publish: async (state) => { published.push(state) } }
  const service = new FeedsService(ports, createSerialQueue(), feeds.fetcher, { timer: stopped })
  await service.ready
  await service.subscribe(npm, "status")
  await eventually(() => expect(published.at(-1)?.results[npm]?.status).toBe("ok"))
  service.dispose()
  service.refresh()
  await expect(service.subscribe("https://other.test/rss", "status")).rejects.toThrow("Feeds stopped on the server")
  await Bun.sleep(150)
  expect(feeds.fetches).toEqual([npm])
  expect(published.at(-1)?.results[npm]?.status).toBe("ok")
})
