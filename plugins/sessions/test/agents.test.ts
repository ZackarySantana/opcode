import { afterEach, expect, test } from "bun:test"
import { closeServers, eventually } from "@opcode/core/test-support/server"
import type { AgentsState, Attention } from "../src/agents"
import { agentsRemote, event, finished, host, sessionsServer, shown } from "./agents-host"
import { session } from "./fixtures"

afterEach(closeServers)

const announced = (server: ReturnType<typeof sessionsServer>, name: string) => server.events.filter((value) => value.name === name).map((value) => value.data)

test("every location shares one list: one snapshot and event stream, terminals' observations, coalesced announcements, and each alert once", async () => {
  const opencode = host([finished("done", 5), session("root", "/work/beta"), { ...session("child", "/work/beta"), parentID: "root" }, session("other")])
  const server = sessionsServer(opencode)
  const alpha = agentsRemote(server, "/work/alpha"), beta = agentsRemote(server, "/work/beta")
  const first = await alpha.state()
  expect(shown(first)).toEqual(["done:finished"])
  // The server can't read what runs, so it asks.
  expect(first.observe).toBeNumber()
  expect((await beta.state()).server).toBe(first.server)
  // Besides each location's indexing, the oldest location's stream serves the list.
  await eventually(() => expect(opencode.streams().sort()).toEqual(["/work/alpha", "/work/alpha", "/work/beta"]))
  expect(opencode.reads.roots).toBe(1)

  // A running subagent of a root the snapshot didn't read, waiting on a permission.
  const observed = await beta.observe({ server: first.server, since: first.revision, running: ["child"], requests: { "permission:per_1": "child" }, listed: ["/work/beta"] })
  expect(observed.observe).toBeUndefined()
  await eventually(async () => expect((await alpha.state()).rows).toMatchObject([{ id: "done" }, { id: "root", state: "needs-you", agents: 1, directory: "/work/beta" }]))

  // Changes close together are announced together, once, though two locations are loaded.
  await eventually(async () => expect(announced(server, "agents").at(-1)).toEqual(await alpha.state()))
  const before = announced(server, "agents").length
  for (const value of [
    event("permission.replied", { sessionID: "child", requestID: "per_1", reply: "once" }),
    event("session.status", { sessionID: "other", status: { type: "busy" } }),
    event("permission.asked", { id: "per_2", sessionID: "child", action: "bash", resources: [] }),
  ]) {
    opencode.emit(value)
    await Bun.sleep(10)
  }
  await eventually(async () => expect(shown(announced(server, "agents").at(-1) as AgentsState)).toEqual(["done:finished", "root:needs-you", "other:working"]))
  expect(announced(server, "agents").length).toBe(before + 1)
  expect(announced(server, "agents").at(-1)).toEqual(await beta.state())

  opencode.emit(event("session.status", { sessionID: "other", status: { type: "idle" } }), event("session.idle", { sessionID: "other" }))
  await eventually(() => expect(announced(server, "attention")).toHaveLength(2))
  expect(announced(server, "attention") as Attention[]).toEqual([
    { kind: "permission", sessionID: "child", root: "root", title: "Session root" },
    { kind: "finished", sessionID: "other", root: "other", title: "Session other" },
  ])
})

test("an observation counts only when made after the service asked, and events since then decide over it", async () => {
  const opencode = host([session("a"), session("b")])
  const server = sessionsServer(opencode)
  const terminal = agentsRemote(server)
  const asked = await terminal.state()
  await eventually(() => expect(opencode.streams()).toHaveLength(2))
  const observation = { running: ["a", "b"], requests: {}, listed: [] }

  // From another service, or before it asked: ignored.
  expect((await terminal.observe({ ...observation, server: "elsewhere", since: asked.revision })).observe).toBe(asked.observe!)
  expect((await terminal.observe({ ...observation, server: asked.server, since: asked.observe! - 1 })).observe).toBe(asked.observe!)
  // "a" goes idle after the terminal read that it runs.
  opencode.emit(event("session.status", { sessionID: "a", status: { type: "idle" } }))
  await eventually(async () => expect((await terminal.state()).revision).toBeGreaterThan(asked.revision))
  expect(shown(await terminal.observe({ ...observation, server: asked.server, since: asked.revision }))).toEqual(["b:working"])
})

test("a read finish stays listed in its place for the server's keepRead, then drops out", async () => {
  const opencode = host([finished("first", 5), finished("second", 6)])
  const server = sessionsServer(opencode, { inbox: { keepRead: 1 } })
  const terminal = agentsRemote(server)
  expect(shown(await terminal.state())).toEqual(["first:finished", "second:finished"])
  await eventually(() => expect(opencode.streams()).toHaveLength(2))

  // Read almost a minute ago.
  opencode.emit(event("session.viewed", { sessionID: "first", idle: 5 }, Date.now() - 60_000 + 400))
  await eventually(async () => expect((await terminal.state()).rows.map((row) => [row.id, row.read])).toEqual([["first", true], ["second", false]]))
  await eventually(async () => expect(shown(announced(server, "agents").at(-1) as AgentsState)).toEqual(["second:finished"]), 2_000)
})

test("when the location serving events unloads, the next takes over, reads the sessions again, and asks what runs", async () => {
  const opencode = host([session("a")])
  const server = sessionsServer(opencode)
  const alpha = agentsRemote(server, "/work/alpha"), beta = agentsRemote(server, "/work/beta")
  const first = await alpha.state()
  await beta.observe({ server: first.server, since: first.revision, running: [], requests: {}, listed: [] })
  await eventually(() => expect(opencode.streams().sort()).toEqual(["/work/alpha", "/work/alpha", "/work/beta"]))

  await server.unload("/work/alpha")
  // Finished while no stream was open: only a new snapshot sees it.
  opencode.sessions.push(finished("missed", 7, "/work/beta"))
  await eventually(() => expect(opencode.streams()).toEqual(["/work/beta", "/work/beta"]))
  await eventually(async () => expect(shown(await beta.state())).toEqual(["missed:finished"]))
  const after = await beta.state()
  expect(after.server).toBe(first.server)
  expect(after.observe).toBeGreaterThan(first.observe!)
})

test("once every location unloads the service stops; the next read starts a new one from a fresh snapshot", async () => {
  const opencode = host([])
  const server = sessionsServer(opencode)
  const terminal = agentsRemote(server)
  const first = await terminal.state()
  await server.close()
  expect(opencode.streams()).toEqual([])
  opencode.sessions.push(finished("later", 9))
  const next = await terminal.state()
  expect(next.server).not.toBe(first.server)
  expect(shown(next)).toEqual(["later:finished"])
})
