import { afterEach, expect, spyOn, test } from "bun:test"
import type { Runner } from "../src/gh"
import { defaultSettings, type PullRequestsState } from "../src/model"
import { joinShared } from "../src/registry"
import type * as ServiceModule from "../src/service"
import { PullRequestsService, type Ports } from "../src/service"
import { closeServers, eventually, fakeServer, ghRunner, stopped } from "./host"

afterEach(closeServers)

test("every location shares one service: one poll, settings saved once for all, and each change announced once", async () => {
  const gh = ghRunner()
  const warn = spyOn(console, "warn")
  const server = fakeServer({ run: gh.run, stored: new Map([["settings", { order: "oldest", ignoreDays: 3, team: "acme/web" }]]) })
  try {
    const home = server.remote("/home/me"), web = server.remote("/work/web")
    expect((await home.state()).settings).toEqual({ ...defaultSettings, order: "oldest", team: "acme/web" })
    await eventually(async () => expect((await web.state()).snapshot?.viewer).toBe("me"))
    expect(gh.searches).toHaveLength(1)

    // A change in one location shows in every other, and is saved without the cleared team.
    const changed = await web.update({ sidebarItems: 10, team: null })
    expect(changed.settings).toEqual({ ...defaultSettings, order: "oldest", sidebarItems: 10 })
    expect((await home.state()).settings).toEqual(changed.settings)
    expect(server.stored.get("settings")).toEqual(changed.settings)
    // A new interval restarts the countdown everyone sees, sent as the time left.
    expect((await home.update({ refreshMinutes: 30 })).nextRefreshIn).toBeGreaterThan(29 * 60_000)

    await home.refresh()
    await eventually(() => expect(gh.searches).toHaveLength(2))
    // Clients receive every location's events, so two loaded locations still announce each change once.
    await eventually(async () => expect((await home.state()).refreshing).toBe(false))
    const revisions = server.events.map((event) => event.state.revision)
    expect(new Set(revisions).size).toBe(revisions.length)
    expect(server.events.at(-1)?.state).toMatchObject({ ...await home.state(), nextRefreshIn: expect.any(Number) })
    // Starting up announces through a registered instance, without a warning.
    expect(warn).not.toHaveBeenCalled()

    // The location that announced changes unloads; another takes over, and the service keeps its state.
    const announcer = server.events.at(-1)!.directory
    await server.unload(announcer)
    const other = announcer === "/home/me" ? web : home
    await other.update({ order: "newest" })
    expect(server.events.at(-1)).toMatchObject({ directory: announcer === "/home/me" ? "/work/web" : "/home/me", state: { settings: { order: "newest" } } })
    expect(gh.searches).toHaveLength(2)

    // Once every location unloads the service stops; the next starts later, from the saved settings, and polls again.
    const before = await other.state()
    await server.close()
    const after = await home.state()
    expect(after.settings).toEqual({ ...defaultSettings, order: "newest", sidebarItems: 10, refreshMinutes: 30 })
    expect(after.server).not.toBe(before.server)
    expect(after.started).toBeGreaterThanOrEqual(before.started)
    await eventually(() => expect(gh.searches).toHaveLength(3))
  } finally { warn.mockRestore() }
})

test("a location whose storage and events fail, while still loaded, doesn't stop a change being saved and announced", async () => {
  const server = fakeServer({ run: ghRunner().run })
  const home = server.remote("/home/me"), web = server.remote("/work/web")
  await home.state()
  await web.state()
  server.faults.locations.add("/home/me")
  await web.update({ order: "newest" })
  expect(server.stored.get("settings")).toMatchObject({ order: "newest" })
  expect(server.events.at(-1)).toMatchObject({ directory: "/work/web", state: { settings: { order: "newest" } } })
})

test("a change that can't be saved fails with the reason and changes nothing; unreadable settings start at the defaults", async () => {
  const gh = ghRunner()
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const server = fakeServer({ run: gh.run, stored: new Map([["settings", { order: "oldest" }]]) })
    server.faults.get = true
    const home = server.remote()
    expect((await home.state()).settings).toEqual(defaultSettings)
    expect(gh.searches).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)

    server.faults.set = true
    await expect(home.update({ order: "newest" })).rejects.toEqual({ type: "failed", message: "disk full" })
    expect((await home.state()).settings).toEqual(defaultSettings)
  } finally { warn.mockRestore() }
})

/** Ports that record what the service announces. */
function recordingPorts() {
  const published: PullRequestsState[] = []
  const ports: Ports = { loadSettings: async () => undefined, saveSettings: async () => {}, publish: async (state) => { published.push(state) } }
  return { ports, published }
}

test("a stopped service announces nothing more and refuses changes", async () => {
  const { ports, published } = recordingPorts()
  const service = new PullRequestsService(ports, ghRunner().run, stopped)
  await service.ready
  await eventually(() => expect(service.state().refreshing).toBe(false))
  const announced = published.length
  service.dispose()
  service.refresh()
  await expect(service.update({ order: "newest" })).rejects.toThrow("Pull requests stopped on the server")
  expect(published).toHaveLength(announced)
  expect(service.state().settings).toEqual(defaultSettings)
})

test("each location's own copy of the code joins the one service in the process", async () => {
  const load = (copy: string) => import(`../src/service.ts?copy=${copy}`) as Promise<typeof ServiceModule>
  const [a, b] = await Promise.all([load("a"), load("b")])
  const run: Runner = async () => ({ stdout: "", stderr: "", status: 1 })
  const first = a.joinService(recordingPorts().ports, (ports) => new a.PullRequestsService(ports, run, stopped))
  const second = b.joinService(recordingPorts().ports, () => { throw new Error("Only the first to join starts the service") })
  try { expect(second.service).toBe(first.service) } finally {
    second.leave()
    first.leave()
  }
})

test("code of another version starts its own shared value, and the last member to leave stops it", () => {
  const stopped: string[] = []
  const lifecycle = (name: string) => ({ start: () => name, stop: (value: string) => { stopped.push(value) } })
  const old = joinShared("test.service@1", "a", lifecycle("old"))
  const same = joinShared("test.service@1", "b", lifecycle("unused"))
  const next = joinShared("test.service@2", "c", lifecycle("new"))
  expect([old.value, same.value, next.value]).toEqual(["old", "old", "new"])
  old.leave()
  expect(stopped).toEqual([])
  same.leave()
  next.leave()
  expect(stopped).toEqual(["old", "new"])
  expect(joinShared("test.service@1", "d", lifecycle("restarted")).value).toBe("restarted")
})

test("review feedback is fetched in the asking location, formatted with the server's commentsPrompt option", async () => {
  const directories: (string | undefined)[] = []
  const view = JSON.stringify({ number: 42, title: "Cache", url: "https://github.com/acme/web/pull/42", headRefName: "cache", state: "OPEN" })
  const feedback = JSON.stringify({ data: { viewer: { login: "me" }, repository: { pullRequest: {
    reviewThreads: { nodes: [] }, reviews: { nodes: [] },
    comments: { nodes: [{ author: { __typename: "User", login: "frank" }, body: "Changelog?", url: "https://github.com/acme/web/pull/42#c1" }] },
  } } } })
  const run: Runner = async (args, _signal, cwd) => {
    if (args[0] === "pr") directories.push(cwd)
    if (cwd === "/work/main") return { stdout: "", stderr: "no pull requests found for branch \"main\"\n", status: 1 }
    return { stdout: args[0] === "pr" ? view : args.includes("graphql") && cwd ? feedback : "", stderr: "", status: 0 }
  }
  const server = fakeServer({ run, options: { commentsPrompt: "Check {branch} (#{pr})." } })
  const signal = new AbortController().signal
  const sent = await server.remote().feedback("/work/web", signal)
  expect(directories).toEqual(["/work/web"])
  expect(sent).toMatchObject({ number: 42, summary: "Included 1 comment.", text: expect.stringMatching(/^Check cache \(#42\)\.\n/) })
  await expect(server.remote().feedback("/work/main", signal)).rejects.toEqual({ type: "failed", message: "no pull requests found for branch \"main\"" })
})
