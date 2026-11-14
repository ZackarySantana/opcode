import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { SAVE_LEAD } from "../src/domain"
import { snippetActions, type ActionHost } from "../src/gui/actions"
import { saveRequest } from "../src/draft"
import { changed, duplicateStart, editStart, newStart } from "../src/gui/draft"
import { displayOrder, filterSnippets, flagOf, groupSnippets, insertion, rowKey, step, summary } from "../src/gui/list"
import { messageOptions } from "../src/gui/messages"
import type { SnippetEntry } from "../src/service"

const t = (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key
const row = (name: string, scope: SnippetEntry["scope"], extra: Partial<SnippetEntry> = {}): SnippetEntry => ({
  name, scope, path: `/${scope}/${name}.md`, aliases: [], body: `${name} body`, overridden: false, conflict: false,
  expanded: `${name} body`, problems: [], breaks: [], ...extra,
})

test("the list shows Project then Global, each by name, and searches names, aliases, descriptions, and text", () => {
  const rows = [
    row("review", "global", { overridden: true }),
    row("plan", "global", { description: "Plan first", aliases: ["p", "pl"] }),
    row("review", "project", { body: "Check the DIFF" }),
    row("ask", "global"),
  ]
  const groups = groupSnippets(rows)
  expect(groups.map((group) => [group.scope, group.rows.map((r) => r.name)])).toEqual([["project", ["review"]], ["global", ["ask", "plan", "review"]]])
  expect(displayOrder(groups).map(rowKey)).toEqual(["project:review", "global:ask", "global:plan", "global:review"])

  const names = (query: string) => filterSnippets(rows, query).map(rowKey)
  expect(names("")).toHaveLength(4)
  expect(names("diff check")).toEqual(["project:review"])
  expect(names("first")).toEqual(["global:plan"])
  expect(names("@pl")).toEqual(["global:plan"])
  // An @word matches names and aliases only, not text that mentions a snippet.
  expect(filterSnippets([row("ticket", "global", { body: "see @plan" })], "@plan")).toEqual([])
  expect(groupSnippets(filterSnippets(rows, "nothing"))).toEqual([])
})

test("rows say why @name would insert something else, before a broken reference", () => {
  expect(flagOf(row("a", "global", { conflict: true, problems: ["x"] }))).toBe("conflict")
  expect(flagOf(row("a", "global", { overridden: true }))).toBe("overridden")
  expect(flagOf(row("a", "global", { problems: ["@gone is not a snippet."] }))).toBe("broken")
  expect(flagOf(row("a", "global"))).toBeUndefined()
  expect(summary(row("a", "global", { body: `  Review\n\nthe ${"diff ".repeat(40)}` }))).toBe(`Review the ${"diff ".repeat(40)}`.slice(0, 99) + "…")
  expect(summary(row("a", "global", { description: "Short" }))).toBe("Short")
})

test("arrow keys move the selection and stop at the ends", () => {
  const rows = [row("a", "global"), row("b", "global"), row("c", "global")]
  expect(step(rows, undefined, 1)?.name).toBe("a")
  expect(step(rows, "global:a", 1)?.name).toBe("b")
  expect(step(rows, "global:c", 1)?.name).toBe("c")
  expect(step(rows, "global:a", -1)?.name).toBe("a")
  expect(step([], undefined, 1)).toBeUndefined()
})

test("a pick inserts @name, unless another snippet or skill would answer to it", () => {
  expect(insertion(row("plan", "global"))).toEqual({ text: "@plan " })
  expect(insertion(row("plan", "global", { overridden: true }))).toEqual({ blocked: "overridden" })
  expect(insertion(row("plan", "global", { conflict: true }))).toEqual({ blocked: "conflict" })
})

test("editing saves over the original, so a rename or a move replaces it", () => {
  const start = editStart(row("plan", "global", { description: "Plan first", aliases: ["p"] }))
  expect(start.draft).toEqual({ name: "plan", scope: "global", description: "Plan first", aliases: "p", body: "plan body" })
  expect(changed(start, start.draft)).toBe(false)
  const moved = { ...start.draft, name: "planning", scope: "project" as const, aliases: "p q" }
  expect(changed(start, moved)).toBe(true)
  expect(saveRequest(moved, start.from)).toMatchObject({ name: "planning", scope: "project", from: { name: "plan", scope: "global" } })
})

test("a duplicate is a new snippet under a free name, without the original's aliases", () => {
  const original = row("plan", "global", { aliases: ["p"] })
  const start = duplicateStart(original, [original, row("plan-copy", "project")])
  expect(start.from).toBeUndefined()
  expect(start.draft).toMatchObject({ name: "plan-copy-2", scope: "global", aliases: "", body: "plan body" })
  expect(saveRequest(start.draft, start.from)).not.toHaveProperty("from")
})

test("a new snippet from a prompt or message starts with its text and counts as unsaved", () => {
  const start = newStart("  Review the diff\n")
  expect(start.draft).toEqual({ name: "", scope: "global", description: "", aliases: "", body: "Review the diff" })
  expect(changed(newStart(), newStart().draft)).toBe(false)
  expect(changed(newStart(), { ...newStart().draft, body: "x" })).toBe(true)
})

const user = (id: string, created: number, text: string) => ({ id, type: "user", text, time: { created } }) as unknown as SessionMessageInfo
const assistant = (id: string, created: number, content: unknown[]) =>
  ({ id, type: "assistant", content, time: { created } }) as unknown as SessionMessageInfo

test("saving a message offers the newest messages with text, by their first line", async () => {
  const messages = [
    user("u1", 1, "First ask"),
    assistant("a1", 2, [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Part one" }, { type: "tool", name: "read" }, { type: "text", text: "Part two" }]),
    assistant("a2", 3, [{ type: "tool", name: "read" }]),
    user("u2", 5, "   "),
    user("u3", 6, "Latest\nask"),
  ]
  const fake = host()
  fake.value.messages = async () => messages
  let offered: unknown
  fake.value.select = async (asked) => { offered = asked.options; return asked.options[1]?.value }
  expect(await snippetActions(fake.value).pickMessage()).toMatchObject({ role: "assistant", text: "Part one\n\nPart two" })
  expect((offered as { title: string; description: string }[]).map((option) => [option.title, option.description])).toEqual([
    ["Latest", `message.user · Latest ask`],
    ["Part one", `message.assistant · Part one Part two`],
    ["First ask", `message.user · First ask`],
  ])
  expect(messageOptions([], (role) => role)).toEqual([])
})

function host(options: { confirm?: boolean[]; agentTools?: boolean; composer?: string | null; save?: () => Promise<{ path: string; breaks: string[] }>; remove?: () => Promise<boolean> } = {}) {
  const calls: unknown[][] = []
  const toasts: { title: string; description?: string; variant?: string }[] = []
  const confirms = [...options.confirm ?? []]
  let text = options.composer ?? ""
  const composer = options.composer === null ? undefined : {
    text: () => text,
    insert: (value: string) => { calls.push(["insert", value]); text += value },
    setText: (value: string) => { calls.push(["setText", value]); text = value },
    focus: () => { calls.push(["focus"]) },
  }
  const value: ActionHost = {
    t,
    toast: (toast) => { toasts.push(toast) },
    confirm: async (asked) => { calls.push(["confirm", asked]); return confirms.shift() ?? false },
    select: async (asked) => { calls.push(["select", asked.title]); return asked.options[0]?.value },
    composer: () => composer,
    remote: {
      list: async () => ({ snippets: [], agentTools: options.agentTools ?? true }),
      save: async (input) => { calls.push(["save", input]); return options.save ? options.save() : { path: "/p.md", breaks: [] } },
      remove: async (input) => { calls.push(["remove", input]); return options.remove ? options.remove() : true },
    },
    describeError: (error) => `described: ${error instanceof Error ? error.message : String(error)}`,
    prompt: async (sent) => { calls.push(["prompt", sent]) },
    messages: async () => [user("u1", 1, "Saved text")],
  }
  return { value, calls, toasts, text: () => text }
}

test("inserting types @name into the prompt and focuses it, or says why not", () => {
  const fake = host({ composer: "Hello " })
  expect(snippetActions(fake.value).insert(row("plan", "global"))).toBe(true)
  expect(fake.text()).toBe("Hello @plan ")
  expect(fake.calls).toEqual([["insert", "@plan "], ["focus"]])

  const blocked = host()
  expect(snippetActions(blocked.value).insert(row("plan", "global", { overridden: true }))).toBe(false)
  expect(blocked.toasts.map((toast) => toast.title)).toEqual([`insert.overridden:{"name":"plan"}`])
  const none = host({ composer: null })
  expect(snippetActions(none.value).insert(row("plan", "global"))).toBe(false)
  expect(none.toasts.map((toast) => toast.title)).toEqual(["toast.noComposer"])
})

test("deleting asks first, naming the file and the snippets that would keep @name as typed", async () => {
  const declined = host({ confirm: [false] })
  expect(await snippetActions(declined.value).remove(row("plan", "global", { breaks: ["ticket", "todo"] }))).toBe(false)
  expect(declined.calls).toEqual([["confirm", {
    title: `delete.title:{"name":"plan"}`,
    description: `delete.description.breaks:{"path":"/global/plan.md","name":"plan","names":"@ticket, @todo"}`,
    confirm: "delete.confirm",
    danger: true,
  }]])

  const accepted = host({ confirm: [true] })
  expect(await snippetActions(accepted.value).remove(row("plan", "project"))).toBe(true)
  expect(accepted.calls.at(-1)).toEqual(["remove", { name: "plan", scope: "project" }])
  expect(accepted.toasts).toEqual([{ title: `delete.done:{"name":"plan"}`, variant: "success" }])

  const failing = host({ confirm: [true], remove: async () => { throw new Error("disk full") } })
  expect(await snippetActions(failing.value).remove(row("plan", "global"))).toBe(false)
  expect(failing.toasts[0]).toMatchObject({ description: "described: disk full", variant: "error" })
})

test("a save reports the snippets it breaks, and a refused save returns the server's reason", async () => {
  const payload = { name: "plan", scope: "global" as const, fields: { aliases: [], body: "x" }, from: { name: "old", scope: "global" as const } }
  const saved = host({ save: async () => ({ path: "/p.md", breaks: ["ticket"] }) })
  expect(await snippetActions(saved.value).save(payload)).toEqual({ ok: true, name: "plan", breaks: ["ticket"] })
  expect(saved.calls).toEqual([["save", payload]])
  expect(saved.toasts).toEqual([{ title: `save.done:{"name":"plan"}`, description: `save.breaks:{"names":"@ticket"}`, variant: "success" }])

  const refused = host({ save: async () => { throw new Error("There is already a global snippet named plan.") } })
  expect(await snippetActions(refused.value).save(payload)).toEqual({ ok: false, error: "described: There is already a global snippet named plan." })
  expect(refused.toasts).toEqual([])
})

test("after saving a prompt, the draft becomes @name only if the user agrees", async () => {
  const kept = host({ confirm: [false], composer: "long prompt" })
  await snippetActions(kept.value).offerReplace("plan")
  expect(kept.text()).toBe("long prompt")
  const replaced = host({ confirm: [true], composer: "long prompt" })
  await snippetActions(replaced.value).offerReplace("plan")
  expect(replaced.text()).toBe("@plan ")
})

test("/snippets save asks this session's agent: a request is sent, none starts one in the prompt", async () => {
  const sent = host()
  await snippetActions(sent.value).askAgent("never commit")
  expect(sent.calls).toEqual([["prompt", `${SAVE_LEAD}never commit`]])

  const empty = host({ composer: "" })
  await snippetActions(empty.value).askAgent("")
  expect(empty.calls).toEqual([["setText", SAVE_LEAD], ["focus"]])

  const drafting = host({ composer: "Keep this. " })
  await snippetActions(drafting.value).askAgent("")
  expect(drafting.text()).toBe(`Keep this. ${SAVE_LEAD}`)

  const off = host({ agentTools: false })
  await snippetActions(off.value).askAgent("never commit")
  expect(off.calls).toEqual([])
  expect(off.toasts.map((toast) => toast.title)).toEqual(["ask.off"])
})

test("saving a message asks which one, and says so when none has text", async () => {
  const fake = host()
  expect(await snippetActions(fake.value).pickMessage()).toMatchObject({ role: "user", text: "Saved text" })
  expect(fake.calls).toEqual([["select", "message.title"]])

  const none = host()
  none.value.messages = async () => [assistant("a1", 1, [{ type: "tool" }])]
  expect(await snippetActions(none.value).pickMessage()).toBeUndefined()
  expect(none.toasts.map((toast) => toast.title)).toEqual(["message.none"])
})
