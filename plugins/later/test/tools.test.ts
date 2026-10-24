import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { tempDir } from "@opcode/ui/test-support/host"
import plugin from "../src/index"
import { LaterDatabase } from "../src/sqlite"

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })

/** The server entry over a database the terminal also opens, as when both load with the same `database` option. */
async function fixture() {
  const directory = tempDir("opcode-later-tools-")
  cleanup.push(directory.remove)
  const path = join(directory.path, "later.sqlite")
  const terminal = new LaterDatabase(path)
  cleanup.push(() => terminal.close())
  const tools: any[] = []
  const approvals: any[] = []
  let decide = async () => {}
  const stop = await plugin.setup({
    options: { database: path },
    tool: { transform: async (callback: any) => callback({ add: (tool: any) => tools.push(tool) }) },
    permission: { assert: async (input: unknown) => { approvals.push(input); await decide() } },
  } as any)
  if (stop) cleanup.push(stop)
  const call = async (name: string, input: unknown) =>
    (await tools.find((tool) => tool.name === name)!.execute(input, { sessionID: "s", agent: "build", messageID: "m", id: "c" })).content as string
  return { terminal, approvals, call, decide: (next: () => Promise<void>) => { decide = next } }
}

test("the agent lists, adds, and completes items in the terminal's list without asking", async () => {
  const f = await fixture()
  const kept = f.terminal.add("from the terminal", 1)
  expect(await f.call("later_add", { message: "  from the agent\n" })).toMatch(/^Added /)
  expect(f.terminal.snapshot().active.map((item) => item.message)).toEqual(["from the terminal", "from the agent"])
  expect(await f.call("later_complete", { id: kept })).toBe("Completed.")
  expect(await f.call("later_complete", { id: kept })).toBe("Already completed.")
  const added = f.terminal.snapshot().active[0]!.id
  expect(JSON.parse(await f.call("later_list", {}))).toEqual({ active: [{ id: added, message: "from the agent" }] })
  expect(JSON.parse(await f.call("later_list", { completed: true })).completed).toEqual([{ id: kept, message: "from the terminal" }])
  await expect(f.call("later_complete", { id: "missing" })).rejects.toThrow("later_list")
  await expect(f.call("later_add", { message: " " })).rejects.toThrow("empty")
  expect(f.approvals).toEqual([])
})

test("deleting asks the user with the item's text, and deletes only what they approved", async () => {
  const f = await fixture()
  const id = f.terminal.add("delete me", 1)
  f.decide(async () => { throw new Error("rejected") })
  await expect(f.call("later_delete", { id })).rejects.toThrow("rejected")
  expect(f.approvals[0]).toMatchObject({ action: "later_delete", resources: ["delete me"], save: ["*"], source: { type: "tool", messageID: "m", id: "c" } })
  expect(f.terminal.get(id)).toBeDefined()

  // The user edits the item in the terminal while the approval is pending.
  f.decide(async () => { f.terminal.edit(f.terminal.get(id)!, "keep me now", 2) })
  expect(await f.call("later_delete", { id })).toContain("changed")
  expect(f.terminal.get(id)?.message).toBe("keep me now")

  f.decide(async () => {})
  expect(await f.call("later_delete", { id })).toBe("Deleted.")
  expect(f.terminal.get(id)).toBeUndefined()
})
