import { afterEach, expect, test } from "bun:test"
import { closeServers, eventually, manualTimers, stopped } from "@opcode/core/test-support/server"
import type { SetTimer } from "@opcode/core/refresh"
import { LaterClient, type Remote } from "../src/client"
import { defaultSettings } from "../src/domain"
import { laterServer, messages, remote } from "./fixture"

afterEach(closeServers)

const clients = new Set<LaterClient>()
afterEach(() => { for (const client of clients) client.dispose(); clients.clear() })
const follow = (remote: Remote, timer: SetTimer = stopped) => {
  const problems: (string | undefined)[] = []
  const client = new LaterClient(remote, (message) => problems.push(message), timer)
  clients.add(client)
  client.start()
  return Object.assign(client, { problems })
}

test("terminals and the agent see each other's changes, and catch up on one missed while disconnected", async () => {
  const f = laterServer()
  const first = follow(remote(f.server, "/home/me"))
  const second = follow(remote(f.server, "/work/web"))
  const id = await first.add("from the first")
  expect(messages(first.list())).toEqual(["from the first"])
  await eventually(() => expect(messages(second.list())).toEqual(["from the first"]))
  await f.tool("later_add", { message: "from the agent" }, "/somewhere/else")
  await eventually(() => expect(messages(first.list())).toEqual(["from the first", "from the agent"]))

  expect(await second.complete(second.item(id)!)).toBe(true)
  await eventually(() => expect(first.list().completed.map((item) => item.id)).toEqual([id]))
  // The first still holds the item as it was before: completing it again is refused, not applied twice.
  await eventually(() => expect(first.item(id)?.completedAt).toBeDefined())
  expect(await second.complete({ ...first.item(id)!, completedAt: undefined })).toBe(false)

  // The change while disconnected is never delivered; reconnecting reads it.
  f.server.disconnect()
  await second.updateSettings({ sidebarItems: 10 })
  await eventually(() => expect(first.settings().sidebarItems).toBe(10))
})

test("setting changes show at once and build on each other; one the server refuses is undone and explained", async () => {
  const f = laterServer()
  const client = follow(remote(f.server))
  // Read once: arriving states clear the problem.
  await eventually(() => expect(client.problems).toContain(undefined))
  const sending = [client.updateSettings({ sidebarItems: 10 }), client.updateSettings({ agentTools: false })]
  expect(client.settings()).toEqual({ sidebarItems: 10, agentTools: false })
  await Promise.all(sending)
  expect(client.settings()).toEqual({ sidebarItems: 10, agentTools: false })

  f.server.faults.set = true
  const refused = client.updateSettings({ sidebarItems: 3 })
  expect(client.settings().sidebarItems).toBe(3)
  await expect(refused).rejects.toThrow("disk full")
  expect(client.settings()).toEqual({ sidebarItems: 10, agentTools: false })
})

test("a list that can't be read is reported, refuses changes, and is read again until it can be", async () => {
  const timers = manualTimers()
  const f = laterServer({ stored: new Map([["list", { revision: 1, active: [{ id: "a", message: "saved", createdAt: 1, updatedAt: 1 }], completed: [], sidebarItems: 3 }]]) })
  f.server.faults.get = true
  const client = follow(remote(f.server), timers.timer)
  await eventually(() => expect(client.problems.at(-1)).toContain("can't be read right now"))
  expect(client.list().active).toEqual([])
  expect(client.settings()).toEqual(defaultSettings)
  await expect(client.add("new")).rejects.toThrow("can't be read right now")

  f.server.faults.get = false
  timers.fire(10_000)
  await eventually(() => expect(messages(client.list())).toEqual(["saved"]))
  expect(client.problems.at(-1)).toBeUndefined()
  expect(client.settings().sidebarItems).toBe(3)
})
