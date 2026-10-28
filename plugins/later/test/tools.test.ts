import { afterEach, expect, test } from "bun:test"
import { closeServers } from "@opcode/core/test-support/server"
import { find, laterServer, messages, read, remote } from "./fixture"

afterEach(closeServers)

test("the agent lists, adds, and completes items in the terminal's list without asking", async () => {
  const f = laterServer()
  const terminal = remote(f.server)
  const kept = (await terminal.add("from the terminal")).id
  // The tools in another location change the same list.
  expect(await f.tool("later_add", { message: "  from the agent\n" }, "/work/web")).toMatch(/^Added /)
  expect(messages(await terminal.state())).toEqual(["from the terminal", "from the agent"])
  expect(await f.tool("later_edit", { id: kept, completed: true })).toBe("Completed.")
  const added = (await terminal.state()).active[0]!.id
  expect(JSON.parse(await f.tool("later_list", {}))).toEqual({ active: [{ id: added, message: "from the agent" }] })
  expect(JSON.parse(await f.tool("later_list", { completed: true })).completed).toEqual([{ id: kept, message: "from the terminal" }])
  await expect(f.tool("later_edit", { id: "missing", completed: true })).rejects.toThrow("later_list")
  await expect(f.tool("later_add", { message: " " })).rejects.toThrow("empty")
  expect(f.approvals).toEqual([])
})

test("editing reports the previous text and can restore a completed item", async () => {
  const f = laterServer()
  const terminal = remote(f.server)
  const id = (await terminal.add("first draft")).id
  await terminal.complete(find(await terminal.state(), id))
  expect(await f.tool("later_edit", { id, message: "second draft", completed: false })).toBe('Edited. Previous text: "first draft". Restored.')
  expect(find(await terminal.state(), id)).toMatchObject({ message: "second draft" })
  expect(find(await terminal.state(), id).completedAt).toBeUndefined()
  await expect(f.tool("later_edit", { id })).rejects.toThrow("message, completed")
  expect(f.approvals).toEqual([])
})

test("turned off, the tools refuse in older sessions and are gone from newer ones until turned back on", async () => {
  const f = laterServer()
  const terminal = remote(f.server)
  const all = ["read", "later_list", "later_add", "later_edit", "later_delete"]
  const before = Date.now() - 1
  await terminal.settings({ agentTools: false })
  const after = Date.now()
  // Sessions created before and after the tools were turned off, in every location.
  expect(await f.listed(before)).toEqual(all)
  expect(await f.listed(after, "/work/web")).toEqual(["read"])
  // Saving again while off, such as a new sidebar count or another "off", must not move the cutoff past newer sessions.
  await Bun.sleep(2)
  await terminal.settings({ sidebarItems: 10, agentTools: false })
  expect(await f.listed(after)).toEqual(["read"])
  expect(await f.tool("later_add", { message: "ignored" })).toBe("The user turned off Later tools. They won't be available in new sessions.")
  expect((await terminal.state()).active).toEqual([])

  await terminal.settings({ agentTools: true })
  expect(await f.listed(after)).toEqual(all)
  expect(await f.tool("later_add", { message: "kept" })).toMatch(/^Added /)
})

test("deleting asks the user with the item's text, and deletes only what they approved", async () => {
  const f = laterServer()
  const terminal = remote(f.server)
  const id = (await terminal.add("delete me")).id
  f.decide(async () => { throw new Error("rejected") })
  await expect(f.tool("later_delete", { id })).rejects.toThrow("rejected")
  expect(f.approvals[0]).toMatchObject({ action: "later_delete", resources: ["delete me"], save: ["*"], source: { type: "tool", messageID: "m", id: "c" } })
  expect(find(await read(f.server), id)).toBeDefined()

  // The user edits the item in the terminal while the approval is pending.
  f.decide(async () => { await terminal.edit(find(await terminal.state(), id), "keep me now") })
  expect(await f.tool("later_delete", { id })).toContain("changed")
  expect(find(await read(f.server), id).message).toBe("keep me now")

  f.decide(async () => {})
  expect(await f.tool("later_delete", { id })).toBe("Deleted.")
  expect(find(await read(f.server), id)).toBeUndefined()
})
