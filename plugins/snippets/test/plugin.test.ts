import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tempDir } from "@opcode/ui/test-support/host"
import plugin from "../src/index"

type Skill = { id: string; name: string; path: string; content: string; autoinvoke?: boolean }
type Hook = (event: any) => Promise<void> | void

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

/** A plugin context whose skill registry replays transforms after built-in skills and before later file skills. */
async function fixture(files: Record<string, string>, laterSkills: Skill[] = [], options: Record<string, unknown> = {}) {
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
  const agents = [{ id: "build", permissions: [] as any[] }, { id: "explore", permissions: [{ action: "*", resource: "*", effect: "deny" }] }]
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
  let handlers: Record<string, (input: unknown, call: unknown) => Promise<any>> = {}
  const approvals: any[] = []
  let approve = true
  const stop = await plugin.setup({
    options,
    location: { directory: join(root.path, "project"), project: { id: "p", directory: join(root.path, "project") } },
    skill: {
      transform: async (callback: any) => { transforms.push(callback); rebuild() },
      reload: async () => rebuild(),
      list: async () => { if (failing) throw new Error("registry unavailable"); return { data: skills } },
    },
    tool: { transform: async (callback: any) => callback({ add: (tool: any) => tools.push(tool) }) },
    session: { hook: async (name: string, callback: Hook) => { hooks[name] = callback } },
    agent: { transform: async (callback: any) => callback({ list: () => agents, update: (id: string, change: any) => change(agents.find((agent) => agent.id === id)) }) },
    permission: { assert: async (input: unknown) => { approvals.push(input); if (!approve) throw new Error("rejected") } },
    rpc: { register: async (_definition: unknown, registered: typeof handlers) => { handlers = registered; return { dispose: async () => {} } } },
  } as any)
  cleanups.push(() => void (stop as () => Promise<void>)())
  const tool = (name: string) => tools.find((tool) => tool.name === name)!
  const call = async (name: string, input: unknown, sessionID = "work") => (await tool(name).execute(input, { sessionID, agent: "build", messageID: "m", id: "c" })).content
  // `guarded` throws what `call.error` makes, carrying the failure's message.
  const rpc = (method: string, input: unknown = {}) =>
    handlers[method]!(input, { signal: new AbortController().signal, error: (_type: string, message: string) => new Error(message) })
  return { root: root.path, hooks, skills: () => skills, tools, agents, approvals, call, rpc, reject: () => { approve = false }, fail: () => { failing = true } }
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

test("every session gets the snippet tools, and every agent asks before writes and deletes", async () => {
  const f = await fixture({})
  expect(f.tools.map((tool) => tool.name)).toEqual(["snippet_list", "snippet_read", "snippet_write", "snippet_delete"])
  expect(f.hooks.context).toBeUndefined()
  expect(f.agents[0]!.permissions).toEqual([
    { action: "snippet_write", resource: "*", effect: "ask" }, { action: "snippet_delete", resource: "*", effect: "ask" },
  ])
  // An agent that denies everything keeps denying: its own rule comes after the ask rules.
  expect(f.agents[1]!.permissions.at(-1)).toEqual({ action: "*", resource: "*", effect: "deny" })
  expect(await f.rpc("list")).toMatchObject({ agentTools: true })
  const off = await fixture({}, [], { agentTools: false })
  expect(off.tools).toEqual([])
  expect(off.agents[0]!.permissions).toEqual([])
  expect(await off.rpc("list")).toMatchObject({ agentTools: false })
})

test("writes and deletes wait for approval under the session's ask rules, and a rejection changes nothing", async () => {
  const f = await fixture({})
  const asked = ["snippet_write", "snippet_delete"]
  await f.call("snippet_write", { name: "fresh", body: "FRESH", scope: "project" })
  expect(f.approvals).toMatchObject([{ sessionID: "work", resources: ["project/fresh"] }])
  expect(asked).toContain(f.approvals[0].action)
  expect(f.skills().find((skill) => skill.id === "fresh")?.content).toBe("FRESH")
  f.reject()
  await expect(f.call("snippet_write", { name: "other", body: "OTHER" })).rejects.toThrow("rejected")
  await expect(f.call("snippet_delete", { name: "fresh", scope: "project" })).rejects.toThrow("rejected")
  expect(asked).toContain(f.approvals[2].action)
  expect(await readdir(join(f.root, "project/.opencode/snippets"))).toEqual(["fresh.md"])
})

test("deletes of missing snippets and writes with aliases that insert other snippets fail without asking", async () => {
  const f = await fixture({
    "config/opencode/snippets/taken.md": "TAKEN",
    "config/opencode/snippets/other.md": "---\naliases: [shared]\n---\nOTHER",
    "project/.opencode/snippets/review.md": "---\naliases: [rv]\n---\nREVIEW",
  })
  await expect(f.call("snippet_delete", { name: "rv", scope: "project" })).rejects.toThrow("rv is an alias of @review. Delete review (project) instead.")
  await expect(f.call("snippet_delete", { name: "review", scope: "global" })).rejects.toThrow("No global snippet named review; there is a project one.")
  await expect(f.call("snippet_write", { name: "triage", body: "TRIAGE", scope: "project", aliases: ["taken", "rv", "tr"] }))
    .rejects.toThrow("These aliases would not insert @triage: taken inserts @taken (global), rv inserts @review (project). Drop or rename them.")
  expect(f.approvals).toEqual([])
  // A project alias wins over a global snippet's alias.
  await f.call("snippet_write", { name: "fresh", body: "FRESH", scope: "project", aliases: ["shared"] })
  expect(f.approvals).toHaveLength(1)
  expect(f.skills().find((skill) => skill.id === "shared")?.content).toBe("FRESH")
})

test("an attached snippet carries the current text of the snippets it uses, and the list reports references that stay as typed", async () => {
  const f = await fixture({
    "config/opencode/snippets/ticket.md": "Do the ticket, then @review",
    "config/opencode/snippets/review.md": "GLOBAL REVIEW",
    "config/opencode/snippets/notes.md": "Ask @report and @someone",
  })
  const content = (id: string) => f.skills().find((skill) => skill.id === id)?.content
  expect(content("ticket")).toBe("Do the ticket, then GLOBAL REVIEW")
  // Another skill's name is not a snippet to expand.
  expect(content("notes")).toBe("Ask @report and @someone")
  // A hand edit to the used snippet, or a project snippet in its place, is picked up when a prompt mentions a snippet.
  await writeFile(join(f.root, "config/opencode/snippets/review.md"), "EDITED REVIEW")
  await f.hooks.prompt!({ prompt: { text: "@ticket", skills: [] } })
  expect(content("ticket")).toBe("Do the ticket, then EDITED REVIEW")
  await mkdir(join(f.root, "project/.opencode/snippets"), { recursive: true })
  await writeFile(join(f.root, "project/.opencode/snippets/review.md"), "PROJECT REVIEW")
  await f.hooks.prompt!({ prompt: { text: "@ticket", skills: [] } })
  expect(content("ticket")).toBe("Do the ticket, then PROJECT REVIEW")
  const problems = JSON.parse(await f.call("snippet_list", {})).map((entry: any) => [entry.scope, entry.name, entry.problems])
  expect(problems).toEqual([
    ["global", "notes", ["@report is not a snippet.", "@someone is not a snippet."]], ["global", "review", []], ["global", "ticket", []], ["project", "review", []],
  ])
})

test("writes with references that would not expand fail without asking, and deletes name the snippets that used the snippet", async () => {
  const f = await fixture({
    "config/opencode/snippets/review.md": "---\naliases: [rv]\n---\nREVIEW @style",
    "config/opencode/snippets/style.md": "STYLE",
    "project/.opencode/snippets/local.md": "LOCAL",
  })
  await expect(f.call("snippet_write", { name: "style", body: "Style, then @rv" }))
    .rejects.toThrow("@style would not expand: @rv → @style loops back to a snippet already being expanded.")
  await expect(f.call("snippet_write", { name: "ticket", body: "@review @local", scope: "global" }))
    .rejects.toThrow("@ticket would not expand: @local is not a snippet. A global snippet can only use global snippets.")
  expect(f.approvals).toEqual([])
  await f.call("snippet_write", { name: "ticket", body: "Ticket: @rv", scope: "global" })
  expect(f.approvals[0].metadata).toMatchObject({ body: "Ticket: @rv", expanded: "Ticket: REVIEW STYLE" })
  expect(f.skills().find((skill) => skill.id === "ticket")?.content).toBe("Ticket: REVIEW STYLE")
  expect(await f.call("snippet_delete", { name: "review", scope: "global" })).toBe("Deleted @review (global). @ticket used @review and now keep that @name as typed. Tell the user.")
  expect(f.approvals[1].metadata).toMatchObject({ breaks: ["ticket"] })
  expect(f.skills().find((skill) => skill.id === "ticket")?.content).toBe("Ticket: @rv")
})

test("the agent renames or moves a snippet in one approved write, and the list follows hand edits without a prompt", async () => {
  const f = await fixture({ "config/opencode/snippets/review.md": "REVIEW", "config/opencode/snippets/ticket.md": "Ticket: @review" })
  const read = JSON.parse(await f.call("snippet_read", { name: "ticket" }))
  expect(read).toMatchObject({ name: "ticket", scope: "global", body: "Ticket: @review", expanded: "Ticket: REVIEW", usedBy: [] })
  expect(JSON.parse(await f.call("snippet_read", { name: "review" })).usedBy).toEqual(["ticket"])
  expect(await f.call("snippet_write", { name: "check", scope: "project", body: "REVIEW", from: { name: "review", scope: "global" } }))
    .toEndWith("It replaces @review (global). @ticket used @review and now keep that @name as typed. Tell the user.")
  expect(f.approvals).toHaveLength(1)
  expect(f.approvals[0].metadata).toMatchObject({ from: "global/review", breaks: ["ticket"] })
  expect(await readdir(join(f.root, "config/opencode/snippets"))).toEqual(["ticket.md"])
  expect(f.skills().find((skill) => skill.id === "check")?.content).toBe("REVIEW")
  // A hand edit reaches the skills without any prompt mentioning a snippet.
  await writeFile(join(f.root, "config/opencode/snippets/ticket.md"), "Ticket: @check")
  for (let attempt = 0; attempt < 100 && f.skills().find((skill) => skill.id === "ticket")?.content !== "Ticket: REVIEW"; attempt++) await Bun.sleep(20)
  expect(f.skills().find((skill) => skill.id === "ticket")?.content).toBe("Ticket: REVIEW")
})

test("saves from the user's client don't ask, never replace another snippet, and rename with from", async () => {
  const f = await fixture({ "config/opencode/snippets/review.md": "REVIEW", "config/opencode/snippets/ticket.md": "Ticket: @review" })
  await expect(f.rpc("save", { name: "ticket", scope: "global", fields: { aliases: [], body: "NEW" } })).rejects.toThrow("There is already a global snippet named ticket.")
  expect(await f.rpc("save", { name: "plan", scope: "project", fields: { description: "Plan first", aliases: ["p"], body: "PLAN" } }))
    .toEqual({ path: join(f.root, "project/.opencode/snippets/plan.md"), breaks: [] })
  expect(await f.rpc("save", { name: "check", scope: "global", fields: { aliases: [], body: "CHECK" }, from: { name: "review", scope: "global" } }))
    .toMatchObject({ breaks: ["ticket"] })
  expect(f.approvals).toEqual([])
  const { snippets } = await f.rpc("list")
  expect(snippets.map((entry: any) => [entry.scope, entry.name, entry.expanded, entry.problems, entry.breaks])).toEqual([
    ["global", "check", "CHECK", [], []], ["global", "ticket", "Ticket: @review", ["@review is not a snippet."], []], ["project", "plan", "PLAN", [], []],
  ])
})
