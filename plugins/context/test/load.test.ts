import { expect, test } from "bun:test"
import { loadSnapshot } from "../src/load"
import { mockHost, user } from "./helpers"

test("loads ascending history pages separately from retained context at the session location", async () => {
  const { host, history, location, locations, catalogReads, sessionReads } = mockHost()
  const cursors: (string | undefined)[] = []
  host.client.message.list = async ({ cursor, sessionID, order }) => {
    expect(sessionID).toBe("s")
    expect(order).toBe("asc")
    cursors.push(cursor)
    return cursor ? { data: [user("u2")], cursor: {} } : { data: history, cursor: { next: "next" } }
  }
  const snapshot = await loadSnapshot(host as never, "s")
  expect(cursors).toEqual([undefined, "next"])
  expect(snapshot.messageCount.user).toBe(2)
  expect(snapshot.retained?.estimatedTokens).toBe(2)
  expect(snapshot.environment.map((item) => item.category)).toEqual(["agent", "instruction", "mcp", "skill", "skill", "tool"])
  expect(locations.length).toBeGreaterThan(0)
  expect(locations.every((value) => value === location)).toBe(true)
  expect(sessionReads).toEqual([{ method: "get", sessionID: "s" }, { method: "context", sessionID: "s" }])
  for (const catalog of ["provider", "model", "agent", "skill", "mcp"]) {
    for (const operation of ["sync", "list"] as const) expect(catalogReads).toContainEqual({ catalog, operation, location })
  }
  expect(catalogReads.every((read) => read.location === location)).toBe(true)
  expect(snapshot.warnings).toEqual([])
})

test("degradation labels cached history and never uses it as retained context", async () => {
  const { host } = mockHost()
  host.client.message.list = async () => { throw new Error("offline") }
  host.client.session.context = async () => { throw new Error("offline") }
  host.client.rpc = () => ({ tools: async () => { throw new Error("missing") } })
  const snapshot = await loadSnapshot(host as never, "s")
  expect(snapshot.history).toBe("cached")
  expect(snapshot.messageCount.user).toBe(1)
  expect(snapshot.retained).toBeUndefined()
  expect(snapshot.utilization).toBeUndefined()
  expect(snapshot.warnings.join(" ")).toContain("Retained context unavailable")
  expect(snapshot.warnings.join(" ")).toContain("enable opcode-context on the server")
})

test("catalog failures retain cached metadata and describe the missing source", async () => {
  const { host } = mockHost()
  host.client.config.get = async () => { throw new Error("offline") }
  host.data.location.agent.sync = async () => { throw new Error("offline") }
  const snapshot = await loadSnapshot(host as never, "s")
  expect(snapshot.environment).toContainEqual({ category: "agent", name: "build", detail: "Build" })
  expect(snapshot.warnings).toContain("Instruction configuration unavailable.")
  expect(snapshot.warnings.join(" ")).toContain("Agents unavailable")
})

test("a repeated history cursor cannot loop forever", async () => {
  const { host, history } = mockHost()
  let requests = 0
  host.client.message.list = async () => { requests++; return { data: history, cursor: { next: "same" } } }
  const snapshot = await loadSnapshot(host as never, "s")
  expect(requests).toBe(2)
  expect(snapshot.history).toBe("cached")
})

test("no session issues no requests, and cancellation propagates instead of becoming degradation", async () => {
  expect((await loadSnapshot({} as never)).available).toBe(false)
  const { host } = mockHost()
  const controller = new AbortController()
  controller.abort()
  host.client.session.get = async () => { controller.signal.throwIfAborted(); throw new Error("unreachable") }
  await expect(loadSnapshot(host as never, "s", controller.signal)).rejects.toBeDefined()
})
