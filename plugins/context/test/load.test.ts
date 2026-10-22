import { expect, test } from "bun:test"
import { createSnapshotLoader } from "../src/load"
import { mockHost, user } from "./helpers"

const loadSnapshot = (host: unknown, sessionID?: string, signal?: AbortSignal) => createSnapshotLoader(host as never, sessionID)(signal)

test("loads ascending history with cursor-owned ordering separately from retained context at the session location", async () => {
  const { host, history, location, locations } = mockHost()
  const cursors: (string | undefined)[] = []
  host.client.message.list = async ({ cursor, sessionID, order }) => {
    if (cursor && order !== undefined) throw new Error("Cursor cannot be combined with order")
    expect(sessionID).toBe("s")
    expect(order).toBe(cursor ? undefined : "asc")
    cursors.push(cursor)
    return cursor ? { data: [user("u2")], cursor: {} } : { data: history, cursor: { next: "next" } }
  }
  const snapshot = await loadSnapshot(host, "s")
  expect(cursors).toEqual([undefined, "next"])
  expect(snapshot.messageCount.user).toBe(2)
  expect(snapshot.history).toBe("live")
  expect(snapshot.retained?.estimatedTokens).toBe(2)
  expect(snapshot.environment.map((item) => item.category)).toEqual(["agent", "instruction", "mcp", "skill", "skill", "tool"])
  expect(locations.length).toBeGreaterThan(0)
  expect(locations.every((value) => value === location)).toBe(true)
  expect(snapshot.warnings).toEqual([])
})

test("partial loads reuse environment data until requested or the session location changes", async () => {
  const { host, syncs } = mockHost()
  let tools = 0, directory = "/session"
  host.client.session.get = async () => ({ location: { directory }, model: undefined })
  host.client.rpc = () => ({ tools: async () => { tools++; return [{ id: `tool-${tools}` }] } })
  host.data.location.agent.sync = async () => { throw new Error("offline") }
  const load = createSnapshotLoader(host as never, "s")
  const toolNames = (snapshot: Awaited<ReturnType<typeof load>>) => snapshot.environment.filter((item) => item.category === "tool").map((item) => item.name)
  const first = await load(undefined, false)
  expect(toolNames(first)).toEqual(["tool-1"])
  const syncCount = syncs.length
  const partial = await load(undefined, false)
  expect(toolNames(partial)).toEqual(["tool-1"])
  expect(syncs).toHaveLength(syncCount)
  expect(partial.warnings.join(" ")).toContain("Agents unavailable")
  expect(toolNames(await load(undefined, true))).toEqual(["tool-2"])
  directory = "/moved"
  expect(toolNames(await load(undefined, false))).toEqual(["tool-3"])
})

test("degradation labels cached history and never uses it as retained context", async () => {
  const { host } = mockHost()
  host.client.message.list = async () => { throw new Error("offline") }
  host.client.session.context = async () => { throw new Error("offline") }
  host.client.rpc = () => ({ tools: async () => { throw new Error("missing") } })
  const snapshot = await loadSnapshot(host, "s")
  expect(snapshot.history).toBe("cached")
  expect(snapshot.messageCount.user).toBe(1)
  expect(snapshot.retained).toBeUndefined()
  expect(snapshot.utilization).toBeUndefined()
  expect(snapshot.warnings.join(" ")).toContain("Retained context unavailable")
  expect(snapshot.warnings.join(" ")).toContain("enable opcode-context on the server")
})

test("failed live history with an empty cache is unavailable, not cached", async () => {
  const { host } = mockHost()
  host.client.message.list = async () => { throw new Error("offline") }
  host.data.session.message.list = () => []
  const snapshot = await loadSnapshot(host, "s")
  expect(snapshot.history).toBe("unavailable")
  expect(snapshot.messageCount.user).toBe(0)
})

test("catalog failures retain cached metadata and describe the missing source", async () => {
  const { host } = mockHost()
  host.client.config.get = async () => { throw new Error("offline") }
  host.data.location.agent.sync = async () => { throw new Error("offline") }
  const snapshot = await loadSnapshot(host, "s")
  expect(snapshot.environment).toContainEqual({ category: "agent", name: "build", detail: "Build" })
  expect(snapshot.warnings).toContain("Instruction configuration unavailable.")
  expect(snapshot.warnings.join(" ")).toContain("Agents unavailable")
})

test("a repeated history cursor cannot loop forever", async () => {
  const { host, history } = mockHost()
  let requests = 0
  host.client.message.list = async () => { requests++; return { data: history, cursor: { next: "same" } } }
  const snapshot = await loadSnapshot(host, "s")
  expect(requests).toBe(2)
  expect(snapshot.history).toBe("cached")
})

test("no session issues no requests, and cancellation propagates instead of becoming degradation", async () => {
  expect((await loadSnapshot({})).available).toBe(false)
  const { host } = mockHost()
  const controller = new AbortController()
  controller.abort()
  host.client.session.get = async () => { controller.signal.throwIfAborted(); throw new Error("unreachable") }
  await expect(loadSnapshot(host, "s", controller.signal)).rejects.toBeDefined()
})
