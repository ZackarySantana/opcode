import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tempDir } from "@opcode/ui/test-support/host"
import plugin from "../src/index"
import { authoringSession } from "../src/domain"

type Skill = { id: string; name: string; path: string; content: string; autoinvoke?: boolean }
type Hook = (event: any) => Promise<void> | void

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

/** A plugin context whose skill registry replays transforms after built-in skills and before later file skills. */
async function fixture(files: Record<string, string>, laterSkills: Skill[] = []) {
  const root = tempDir("opcode-snippets-plugin-")
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(root.path, "config")
  cleanups.push(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    root.remove()
  })
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root.path, path, ".."), { recursive: true })
    await writeFile(join(root.path, path), text)
  }
  const sessions: Record<string, { metadata?: unknown; permissions?: unknown }> = {
    normal: {}, authoring: authoringSession({}), unprotected: { metadata: authoringSession({}).metadata },
  }
  const transforms: ((editor: any) => void)[] = []
  let skills: Skill[] = []
  let failing = false
  const rebuild = () => {
    const registry = new Map<string, Skill>([["report", { id: "report", name: "Report", path: "/builtin/report.md", content: "" }]])
    for (const transform of transforms) transform({ get: (id: string) => registry.get(id), add: (skill: Skill) => registry.set(skill.id, skill) })
    for (const skill of laterSkills) registry.set(skill.id, skill)
    skills = [...registry.values()]
  }
  const hooks: Record<string, Hook> = {}
  const tools: any[] = []
  const approvals: any[] = []
  let approve = true
  await plugin.setup({
    location: { directory: join(root.path, "project"), project: { id: "p", directory: join(root.path, "project") } },
    skill: {
      transform: async (callback: any) => { transforms.push(callback); rebuild() },
      reload: async () => rebuild(),
      list: async () => { if (failing) throw new Error("registry unavailable"); return { data: skills } },
    },
    tool: { transform: async (callback: any) => callback({ add: (tool: any) => tools.push(tool) }) },
    session: { hook: async (name: string, callback: Hook) => { hooks[name] = callback }, get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID]! },
    permission: { assert: async (input: unknown) => { approvals.push(input); if (!approve) throw new Error("rejected") } },
    rpc: { register: async () => ({ dispose: async () => {} }) },
  } as any)
  const tool = (name: string) => tools.find((tool) => tool.name === name)!
  const call = async (name: string, input: unknown, sessionID = "authoring") => (await tool(name).execute(input, { sessionID, agent: "build", messageID: "m", id: "c" })).content
  return { root: root.path, hooks, skills: () => skills, approvals, call, reject: () => { approve = false }, fail: () => { failing = true } }
}

test("pasted @name attaches each available snippet once and leaves the text as typed", async () => {
  const f = await fixture({
    "config/opencode/snippets/review.md": "GLOBAL REVIEW",
    "project/.opencode/snippets/review.md": "---\naliases: [rv]\n---\nPROJECT REVIEW",
    "project/.opencode/snippets/note.md": "NOTE",
    "project/.opencode/snippets/report.md": "loses to the built-in skill",
    "project/.opencode/snippets/later.md": "loses to a later skill source",
  }, [{ id: "later", name: "Later", path: "/skills/later.md", content: "" }])
  expect(f.skills().find((skill) => skill.id === "review")).toMatchObject({ content: "PROJECT REVIEW", autoinvoke: false })
  // `@note` was picked as an agent, and `@review.md` is a file path.
  const text = "@rv @review @later @note @review.md"
  const event = { prompt: { text, agents: [{ name: "note", mention: { start: 19, end: 24, text: "@note" } }], skills: [] as any[] } }
  await f.hooks.prompt!(event)
  expect(event.prompt.text).toBe(text)
  expect(event.prompt.skills).toEqual([{ id: "rv", mention: { start: 0, end: 3, text: "@rv" } }])
  // A snippet picked from `@` completion is not attached again, even by its alias.
  const attached = { prompt: { text: "@review @rv", skills: [{ id: "review", mention: { start: 0, end: 7, text: "@review" } }] } }
  await f.hooks.prompt!(attached)
  expect(attached.prompt.skills).toEqual([{ id: "review", mention: { start: 0, end: 7, text: "@review" } }])
  // /snippets and snippet_list flag what the user cannot insert.
  const flags = JSON.parse(await f.call("snippet_list", {})).map((entry: any) => [entry.scope, entry.name, entry.overridden, entry.conflict])
  expect(flags).toEqual([
    ["global", "review", true, false], ["project", "later", false, true], ["project", "note", false, false],
    ["project", "report", false, true], ["project", "review", false, false],
  ])
})

test("a snippet failure never blocks sending the prompt", async () => {
  const f = await fixture({ "config/opencode/snippets/review.md": "REVIEW" })
  f.fail()
  const event = { prompt: { text: "@review", skills: [] as any[] } }
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try { await f.hooks.prompt!(event) } finally { warn.mockRestore() }
  expect(event.prompt).toEqual({ text: "@review", skills: [] })
})

test("snippet tools exist only in authoring sessions that still ask before writing", async () => {
  const f = await fixture({})
  const context = async (sessionID: string) => {
    const event = { sessionID, tools: { snippet_list: {}, snippet_write: {}, snippet_delete: {}, read: {} } }
    await f.hooks.context!(event)
    return Object.keys(event.tools)
  }
  expect(await context("normal")).toEqual(["read"])
  expect(await context("unprotected")).toEqual(["read"])
  expect(await context("authoring")).toEqual(["snippet_list", "snippet_write", "snippet_delete", "read"])
  for (const sessionID of ["normal", "unprotected"]) {
    await expect(f.call("snippet_list", {}, sessionID)).rejects.toThrow("only available in a snippet authoring session")
  }
})

test("writes and deletes wait for approval under the session's ask rules, and a rejection changes nothing", async () => {
  const f = await fixture({})
  const asked = authoringSession({}).permissions.map((rule) => rule.action)
  await f.call("snippet_write", { name: "fresh", body: "FRESH", scope: "project" })
  expect(f.approvals).toMatchObject([{ sessionID: "authoring", resources: ["project/fresh"] }])
  expect(asked).toContain(f.approvals[0].action)
  expect(f.skills().find((skill) => skill.id === "fresh")?.content).toBe("FRESH")
  f.reject()
  await expect(f.call("snippet_write", { name: "other", body: "OTHER" })).rejects.toThrow("rejected")
  await expect(f.call("snippet_delete", { name: "fresh", scope: "project" })).rejects.toThrow("rejected")
  expect(asked).toContain(f.approvals[2].action)
  expect(await readdir(join(f.root, "project/.opencode/snippets"))).toEqual(["fresh.md"])
})
