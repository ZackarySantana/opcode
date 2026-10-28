import { expect, test } from "bun:test"
import type { Runner } from "../src/gh"
import { defaultSettings, readSettings } from "../src/model"
import { eventually, fakeServer, ghRunner } from "./host"

test("stored settings read over the defaults: a field that isn't one of its choices, or is missing, keeps its default", () => {
  expect(readSettings(undefined)).toEqual(defaultSettings)
  expect(readSettings("corrupt")).toEqual(defaultSettings)
  expect(readSettings({ order: "oldest", ignoreDays: 3, sidebarMine: "no", sidebarItems: 10, team: "acme/web", retired: true }))
    .toEqual({ ...defaultSettings, order: "oldest", sidebarItems: 10, team: "acme/web" })
  expect(readSettings({ team: "" })).toEqual(defaultSettings)
})

test("every location shares one service: one poll, settings saved once for all, and each change announced once", async () => {
  const gh = ghRunner()
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
    // A new interval restarts the countdown everyone sees.
    expect((await home.update({ refreshMinutes: 30 })).nextRefresh).toBeGreaterThan(Date.now() + 29 * 60_000)

    await home.refresh()
    await eventually(() => expect(gh.searches).toHaveLength(2))
    // Clients receive every location's events, so two loaded locations still announce each change once.
    await eventually(async () => expect((await home.state()).refreshing).toBe(false))
    const revisions = server.events.map((event) => event.state.revision)
    expect(new Set(revisions).size).toBe(revisions.length)
    expect(server.events.at(-1)?.state).toEqual(await home.state())

    // The location that announced changes unloads; another takes over, and the service keeps its state.
    const announcer = server.events.at(-1)!.directory
    await server.unload(announcer)
    const other = announcer === "/home/me" ? web : home
    await other.update({ order: "newest" })
    expect(server.events.at(-1)).toMatchObject({ directory: announcer === "/home/me" ? "/work/web" : "/home/me", state: { settings: { order: "newest" } } })
    expect(gh.searches).toHaveLength(2)

    // Once every location unloads the service stops; the next starts from the saved settings and polls again.
    await server.close()
    expect((await home.state()).settings).toEqual({ ...defaultSettings, order: "newest", sidebarItems: 10, refreshMinutes: 30 })
    await eventually(() => expect(gh.searches).toHaveLength(3))
  } finally { await server.close() }
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
  try {
    const signal = new AbortController().signal
    const sent = await server.remote().feedback("/work/web", signal)
    expect(directories).toEqual(["/work/web"])
    expect(sent).toMatchObject({ number: 42, summary: "Included 1 comment.", text: expect.stringMatching(/^Check cache \(#42\)\.\n/) })
    await expect(server.remote().feedback("/work/main", signal)).rejects.toEqual({ type: "failed", message: "no pull requests found for branch \"main\"" })
  } finally { await server.close() }
})
