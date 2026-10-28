import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { failover, joinShared, packageVersion } from "../src/process"
import type * as ProcessModule from "../src/process"

test("each module copy, as a location may load, joins the one value in the process", async () => {
  const load = (copy: string) => import(`../src/process.ts?copy=${copy}`) as Promise<typeof ProcessModule>
  const [a, b] = await Promise.all([load("a"), load("b")])
  const stopped: string[] = []
  const first = a.joinShared("test.copies@1", "a", { start: () => "shared", stop: (value) => { stopped.push(value) } })
  const second = b.joinShared("test.copies@1", "b", { start: (): string => { throw new Error("Only the first to join starts it") }, stop: () => { stopped.push("not the starter") } })
  expect(second.value).toBe(first.value)
  first.leave()
  second.leave()
  expect(stopped).toEqual(["shared"])
})

test("code of another version starts its own value; the last member to leave stops it, and leaving twice counts once", () => {
  const stopped: string[] = []
  const lifecycle = (name: string) => ({ start: () => name, stop: (value: string) => { stopped.push(value) } })
  const old = joinShared("test.service@1", "a", lifecycle("old"))
  const same = joinShared("test.service@1", "b", lifecycle("unused"))
  const next = joinShared("test.service@2", "c", lifecycle("new"))
  expect([old.value, same.value, next.value]).toEqual(["old", "old", "new"])
  old.leave()
  old.leave()
  expect(stopped).toEqual([])
  same.leave()
  next.leave()
  expect(stopped).toEqual(["old", "new"])
  expect(joinShared("test.service@1", "d", lifecycle("restarted")).value).toBe("restarted")
})

test("start sees the members still joined, oldest first", () => {
  let members: () => readonly string[] = () => []
  const a = joinShared("test.members@1", "a", { start: (current) => { members = current; return 0 }, stop: () => {} })
  const b = joinShared("test.members@1", "b", { start: () => 1, stop: () => {} })
  const c = joinShared("test.members@1", "c", { start: () => 2, stop: () => {} })
  expect(members()).toEqual(["a", "b", "c"])
  b.leave()
  expect(members()).toEqual(["a", "c"])
  a.leave()
  c.leave()
})

test("failover uses the first member that works, skips ones that left, and throws the last failure", async () => {
  const members = ["a", "b", "c"]
  const used: string[] = []
  const use = async (member: string) => {
    used.push(member)
    if (member === "a") { members.splice(members.indexOf("b"), 1); throw new Error("a gone") }
    if (member === "c") return "c worked"
    throw new Error(`${member} failed`)
  }
  expect(await failover(() => members, use)).toBe("c worked")
  expect(used).toEqual(["a", "c"])
  await expect(failover(() => ["x", "y"], async (member) => { throw new Error(`${member} failed`) })).rejects.toThrow("y failed")
  await expect(failover(() => [], async () => 1)).rejects.toThrow("No plugin instance is loaded")
})

test("a package's version comes from its manifest, or is unknown", () => {
  const directory = mkdtempSync(join(tmpdir(), "opcode-version-"))
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "x", version: "1.2.3" }))
    expect(packageVersion(pathToFileURL(join(directory, "package.json")))).toBe("1.2.3")
    expect(packageVersion(pathToFileURL(join(directory, "missing.json")))).toBe("unknown")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
