import { expect, test } from "bun:test"
import { PullRequestsClient } from "../src/client"
import { defaultSettings, type PullRequestsState, type SettingsChange } from "../src/model"
import type { Remote } from "../src/rpc"
import { eventually, fakeServer, ghRunner, stopped } from "./host"

test("terminals show each other's changes, and catch up on one they missed while disconnected", async () => {
  const gh = ghRunner()
  const server = fakeServer({ run: gh.run })
  const first = new PullRequestsClient(server.remote("/home/me"), stopped)
  const second = new PullRequestsClient(server.remote("/work/web"), stopped)
  try {
    first.start()
    second.start()
    await eventually(() => expect(second.snapshot()?.viewer).toBe("me"))
    expect(gh.searches).toHaveLength(1)
    expect(second.nextRefresh()).toBeGreaterThan(Date.now())

    first.updateSettings({ order: "newest" })
    await eventually(() => expect(second.settings().order).toBe("newest"))
    first.refresh()
    await eventually(() => expect(gh.searches).toHaveLength(2))
    await eventually(() => expect(second.refreshing()).toBe(false))

    // The change while disconnected is never delivered; reconnecting reads it.
    server.disconnect()
    first.updateSettings({ team: "acme/web" })
    await eventually(() => expect(second.settings().team).toBe("acme/web"))
  } finally {
    first.dispose()
    second.dispose()
    await server.close()
  }
})

/** A server whose answers and announcements the test makes. */
function scriptedRemote(initial: PullRequestsState) {
  const announce: ((state: PullRequestsState) => void)[] = []
  const updates: { change: SettingsChange; answer: ReturnType<typeof Promise.withResolvers<PullRequestsState>> }[] = []
  const remote: Remote = {
    state: async () => initial,
    update: (change) => { const answer = Promise.withResolvers<PullRequestsState>(); updates.push({ change, answer }); return answer.promise },
    refresh: async () => initial,
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
  }
  return { remote, updates, announce: (state: PullRequestsState) => announce.forEach((push) => push(state)) }
}

const state = (server: string, revision: number, settings: Partial<PullRequestsState["settings"]> = {}): PullRequestsState =>
  ({ server, revision, settings: { ...defaultSettings, ...settings }, refreshing: false })

test("a terminal keeps the newest state through duplicates and late arrivals, and starts over with a restarted server", async () => {
  const scripted = scriptedRemote(state("a", 1))
  const client = new PullRequestsClient(scripted.remote, stopped)
  try {
    client.start()
    await eventually(() => expect(client.settings().order).toBe("smart"))
    scripted.announce(state("a", 3, { order: "oldest" }))
    scripted.announce(state("a", 2, { order: "newest" }))
    scripted.announce(state("a", 3, { order: "oldest" }))
    await eventually(() => expect(client.settings().order).toBe("oldest"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.settings().order).toBe("oldest")
    scripted.announce(state("b", 0, { order: "newest" }))
    await eventually(() => expect(client.settings().order).toBe("newest"))
  } finally { client.dispose() }
})

test("setting changes show at once and build on each other; one the server refuses is undone and explained", async () => {
  const scripted = scriptedRemote(state("a", 1))
  const client = new PullRequestsClient(scripted.remote, stopped)
  try {
    client.start()
    await eventually(() => expect(client.settings()).toEqual(defaultSettings))
    client.updateSettings({ ignoreDays: 14 })
    client.updateSettings({ ignoreDays: 7, team: "acme/web" })
    expect(client.settings()).toEqual({ ...defaultSettings, ignoreDays: 7, team: "acme/web" })

    // Sent one at a time, in order.
    await eventually(() => expect(scripted.updates).toHaveLength(1))
    scripted.updates[0]!.answer.resolve(state("a", 2, { ignoreDays: 14 }))
    expect(client.settings().ignoreDays).toBe(7)
    await eventually(() => expect(scripted.updates).toHaveLength(2))
    scripted.updates[1]!.answer.reject({ type: "failed", message: "disk full" })
    await eventually(() => expect(client.error()).toBe("disk full"))
    expect(client.settings()).toEqual({ ...defaultSettings, ignoreDays: 14 })

    client.updateSettings({ team: "acme/web" })
    expect(client.settings().team).toBe("acme/web")
    client.updateSettings({ team: null })
    expect(client.settings().team).toBeUndefined()
  } finally { client.dispose() }
})
