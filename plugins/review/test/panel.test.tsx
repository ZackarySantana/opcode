/** @jsxImportSource @opentui/solid */

import { expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { FileDiffInfo, ModelInfo, SessionMessageInfo } from "@opencode/client"
import { testRender } from "@opentui/solid"
import { Show } from "solid-js"
import { ReviewController } from "../src/host"
import { ReviewPanel } from "../src/panel"
import { patch } from "./fixtures"
import type { Reply } from "../src/review"
import { fakeHost, fakePanel, fastTimer, SESSION, settle } from "./host"

const ID = "opcode-review"
const file = (text = patch): FileDiffInfo => ({ file: "src/auth.ts", patch: text, additions: 3, deletions: 3, status: "modified" })
const other: FileDiffInfo = { file: "src/db.ts", patch: "@@ -1,1 +1,1 @@\n-const pool = 1\n+const pool = 2\n", additions: 1, deletions: 1, status: "modified" }
/** The fixture with two lines added above the ttl change. */
const shifted = () => file(patch.replace(" const user = load()", " const user = load()\n+// one\n+// two").replace("@@ -1,4 +1,5 @@", "@@ -1,4 +1,7 @@"))

const model = (id: string, family: string, name: string) => ({ id, providerID: "anthropic", family, name, enabled: true, status: "active" }) as ModelInfo
const models = { default: model("claude-opus", "claude-opus", "Claude Opus"), list: [model("claude-opus", "claude-opus", "Claude Opus"), model("claude-haiku", "claude-haiku", "Claude Haiku")] }

async function setup(width = 90, options: Parameters<typeof fakeHost>[0] = {}) {
  let files = [file(), other]
  let answered: Record<string, Reply> = {}
  const host = fakeHost({ diff: () => files, models, ...options })
  const panel = fakePanel(width)
  const review = new ReviewController(host.api, { replies: async () => answered, timer: fastTimer })
  const view = await testRender(() => (
    <PluginContextProvider value={host.api}>
      <Show when={!panel.state.closed}><ReviewPanel panel={panel.input} review={review} /></Show>
    </PluginContextProvider>
  ), { width, height: 40 })
  // The current frame may already show it: waiting only sees frames rendered later, and a settled tree renders none.
  const frame = async (text: string | RegExp) => {
    const matches = (current: string) => typeof text === "string" ? current.includes(text) : text.test(current)
    await view.renderOnce()
    const current = view.captureCharFrame()
    return matches(current) ? current : view.waitForFrame(matches)
  }
  const run = async (...ids: string[]) => { for (const id of ids) { host.dispatch(`${ID}.${id}`); await settle() } }
  const write = async (text: string) => {
    await view.mockInput.typeText(text)
    view.mockInput.pressEnter()
    await settle()
  }
  return {
    ...host, view, frame, run, write, panel, review,
    /** The agent replies, and a tool finishing tells the panel to look. */
    reply: async (replies: Record<string, Reply>) => {
      answered = replies
      host.emit("session.tool.success", { sessionID: SESSION })
      await settle()
      await settle()
    },
    /** The agent edits: a finished step refreshes the diff after its debounce. */
    change: async (next: FileDiffInfo[]) => {
      files = next
      host.emit("session.step.ended", { sessionID: SESSION })
      await settle()
      await settle()
    },
    dispose: async () => { await view.dispose(); review.dispose() },
  }
}

test("comment on a line, send it to the agent, and see it wait for the agent", async () => {
  const { frame, run, write, prompts, setPending, dispatch, dispose } = await setup()
  try {
    expect(await frame("const ttl = Number(env.TTL ?? 3600)")).toContain("1/2 src/auth.ts")
    await run("down", "down", "down", "comment")
    await frame("New comment on line 2")
    // Panel keys stay out of the way while you type.
    expect(dispatch(`${ID}.down`)).toBe(false)
    await write("Read it from config??")
    const drafted = await frame("r1 line 2 · question · draft")
    expect(drafted).toContain("Read it from config??")
    expect(drafted).toContain("S send 1")

    await run("send")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.text).toContain("[r1] src/auth.ts:2")
    expect(prompts[0]!.text).toContain("Read it from config")
    setPending([prompts[0]!.id!])
    await frame("r1 line 2 · question · waiting for the agent")
  } finally { await dispose() }
})

test("escape in the comment box saves it without sending or closing; escape again sends and closes", async () => {
  const { frame, run, view, prompts, panel, dispose } = await setup()
  try {
    await frame("const ttl = Number(env.TTL ?? 3600)")
    await run("down", "comment")
    await frame("New comment on removed line 2")
    await view.mockInput.typeText("Keep this")
    await run("editor.save")
    await frame("r1 removed line 2 · draft")
    expect(prompts).toHaveLength(0)
    expect(panel.state.closed).toBe(0)

    await run("leave")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.text).toContain("[r1] src/auth.ts:2 (removed lines)")
    expect(panel.state.closed).toBe(1)
  } finally { await dispose() }
})

test("closing the panel keeps the line you were on and a half-written comment", async () => {
  const { frame, run, view, panel, dispose } = await setup()
  try {
    await frame("const ttl = Number(env.TTL ?? 3600)")
    await run("down", "down", "down", "down", "comment")
    await frame("New comment on line 3")
    await view.mockInput.typeText("half")
    panel.set("closed", 1)
    await view.waitForFrame((current) => !current.includes("Review"))
    panel.set("closed", 0)
    expect(await frame("half")).toContain("New comment on line 3")
    view.mockInput.pressEnter()
    expect(await frame("r1 line 3 · draft")).toMatch(/▶ 3 \+ if \(!ttl\)/)
  } finally { await dispose() }
})

test("drafts can be edited, emptied away, or deleted; a sent comment stays as sent", async () => {
  const { frame, run, write, view, dispose } = await setup()
  try {
    await frame("const ttl = Number(env.TTL ?? 3600)")
    await run("down", "down", "down", "comment")
    await write("first")
    await frame("r1 line 2 · draft")

    await run("comment")
    expect(await frame("Editing r1 on line 2")).toContain("first")
    await write(" and more")
    await frame("first and more")

    // Saving it empty deletes it.
    await run("comment")
    await frame("Editing r1")
    for (let index = 0; index < "first and more".length; index++) view.mockInput.pressBackspace()
    view.mockInput.pressEnter()
    await view.waitForFrame((current) => !current.includes("r1 line 2"))

    await run("comment")
    await write("second")
    await frame("r2 line 2 · draft")
    await run("delete")
    await view.waitForFrame((current) => !current.includes("r2 line 2"))

    await run("comment")
    await write("third")
    await run("send")
    await frame("r3 line 2 · sent")
    // On a sent comment, c starts a new one; x leaves it.
    await run("delete")
    await run("comment")
    await frame("New comment on line 2")
  } finally { await dispose() }
})

test("a range comment covers every line from the mark to the cursor", async () => {
  const { frame, run, write, prompts, dispose } = await setup()
  try {
    await frame("const ttl = Number(env.TTL ?? 3600)")
    await run("down", "down", "down", "range", "down", "comment")
    await frame("New comment on line 2-3")
    await write("Both lines")
    await frame("r1 line 2-3 · draft")
    await run("send")
    expect(prompts[0]!.text).toContain("[r1] src/auth.ts:2-3")
  } finally { await dispose() }
})

test("as the agent edits, the cursor and comments follow their lines, and a viewed file returns when its patch changes", async () => {
  const { frame, run, write, change, dispose } = await setup()
  try {
    await frame("const ttl = Number(env.TTL ?? 3600)")
    await run("down", "down", "down", "comment")
    await write("Use config")
    await frame("r1 line 2 · draft")

    // Marking a file viewed moves to the next one waiting.
    await run("viewed")
    expect(await frame("2/2 src/db.ts")).toContain("const pool = 2")
    await run("file.previous")
    await frame(/1\/2 src\/auth\.ts.*viewed/)
    await run("down", "down", "down")

    // Two lines land above the commented one: the comment and the cursor move with it, and the file wants another look.
    await change([shifted(), other])
    const moved = await frame("r1 line 4 · draft")
    expect(moved).toContain("// two")
    expect(moved).not.toMatch(/src\/auth\.ts.*viewed/)
    expect(moved).toMatch(/▶ 4 \+ const ttl = Number/)
    expect(moved.indexOf("r1 line 4")).toBeGreaterThan(moved.indexOf("const ttl = Number"))

    // When the text is gone from the diff, the comment is listed apart rather than pinned to the wrong line.
    await change([file("@@ -1,1 +1,1 @@\n-a\n+b\n"), other])
    expect(await frame("Not in this diff any more")).toContain("r1 line 4 · draft")
  } finally { await dispose() }
})

test("switching sessions shows that session's review, without a range or drafts from the last one", async () => {
  const { frame, run, write, panel, review, dispose } = await setup()
  try {
    await frame("const ttl = Number(env.TTL ?? 3600)")
    await run("down", "down", "down", "comment")
    await write("In the first session")
    await run("range", "down")
    await frame("v end range")

    panel.set("sessionID", "ses_other")
    const switched = await frame((/v range/))
    expect(switched).not.toContain("r1 line 2")
    expect(switched).toMatch(/▶ 1   const user/)
    await run("comment")
    await write("In the second")
    expect(review.review("ses_other").comments.map((comment) => [comment.id, comment.start])).toEqual([["r1", 1]])
    expect(review.review(SESSION).comments.map((comment) => comment.text)).toEqual(["In the first session"])
  } finally { await dispose() }
})

test("options switch the file list between a folder tree and full paths, and choose what to review", async () => {
  const { frame, run, choose, dispatch, dispose } = await setup(120)
  try {
    const tree = await frame("▾ src")
    expect(tree).toMatch(/ {2}● auth\.ts \+3 -3/)
    expect(tree).toMatch(/ {2}● db\.ts \+1 -1/)

    choose("paths")
    await run("options")
    expect(await frame("● src/db.ts +1 -1")).not.toContain("▾ src")

    choose("working")
    await run("options")
    await frame("Review Uncommitted")
    choose("base", "dev")
    await run("options")
    await frame("Review Branch vs dev")

    // The view has moved into options; d is free.
    expect(dispatch(`${ID}.view`)).toBe(false)
  } finally { await dispose() }
})

test("a narrow panel shows the folder tree above the diff by default, and b hides it", async () => {
  const { frame, run, view, dispose } = await setup(90)
  try {
    const opened = await frame("▾ src")
    // The tree comes first, then the open file's diff.
    expect(opened.indexOf("▾ src")).toBeLessThan(opened.indexOf("1/2 src/auth.ts"))
    expect(opened).toMatch(/ {2}● auth\.ts \+3 -3/)
    await run("files")
    await view.waitForFrame((current) => !current.includes("▾ src"))
  } finally { await dispose() }
})

test("/ searches the paths and lines of the diff; a match opens on its row, n goes to the next, and escape comes back", async () => {
  const { frame, run, view, dispatch, dispose } = await setup()
  try {
    await frame("const ttl = Number(env.TTL ?? 3600)")
    await run("search")
    await view.mockInput.typeText("ttl")
    expect(await frame("0 files · 3 lines")).toMatch(/src\/auth\.ts:3 -const ttl = 3600/)
    // Typing keeps the letters in the box, not the panel's keys.
    expect(dispatch(`${ID}.options`)).toBe(false)
    // Escape while typing keeps the results to browse; / types again.
    await run("search.back")
    await frame("j/k move")
    await run("search.type")
    await frame("enter open  esc done")

    await run("search.down", "search.open")
    expect(await frame("← diff › search \"ttl\" › src/auth.ts:2")).toMatch(/▶ 2 \+ const ttl = Number/)
    await run("result.next")
    expect(await frame("src/auth.ts:3")).toMatch(/▶ 3 \+ if \(!ttl\)/)

    await run("leave")
    await frame("3 lines")
    await run("search.back")
    await frame("1/2 src/auth.ts")

    // Files by name, and shift+j / shift+k for the next and previous file.
    await run("search")
    await view.mockInput.typeText("db")
    await frame("1 file · 0 lines")
    await run("search.open")

    await frame("src/db.ts:")
    await run("leave", "search.back")
    await run("file.next")
    await frame("2/2 src/db.ts")
  } finally { await dispose() }
})

test("the footer says how to get back to the conversation, and ? hides the keys", async () => {
  const { frame, run, view, dispose } = await setup()
  try {
    expect(await frame("q back to the conversation")).toContain("? hide keys")
    await run("keys")
    await view.waitForFrame((current) => current.includes("? keys") && !current.includes("c comment"))
  } finally { await dispose() }
})

test("C lists every comment with the agent's reply in full, marks new replies until seen, and opens a comment where it is", async () => {
  const { frame, run, write, reply, view, dispose } = await setup()
  try {
    await frame("const ttl = Number(env.TTL ?? 3600)")
    await run("down", "down", "down", "comment")
    await write("Read it from config??")
    await run("send")
    await run("down", "comment")
    await write("Also guard zero")
    // No reply yet, so nothing new.
    await frame("[C 2 comments]")

    await reply({ r1: { status: "answered", reply: "Config isn't loaded this early, so env is the only source here.", at: 5 } })
    await frame("● 1 new")
    await run("comments")
    const list = await frame(/Comments\s+2 comments · 1 to send · 1 replied/)
    expect(list).toMatch(/r1 src\/auth\.ts:2 · question · sent/)
    expect(list).toMatch(/● new\s+↳ answered: Config isn't loaded this early/)
    expect(list).toMatch(/r2 src\/auth\.ts:3 · draft/)
    // Seen now: the header no longer counts it as new.
    expect(list).not.toMatch(/\[C 2 comments ● 1 new\]/)

    // A draft can go from here; enter opens the other where it is.
    await run("comments.down", "comments.delete")
    await view.waitForFrame((current) => !current.includes("Also guard zero"))
    await run("comments.open")
    expect(await frame("← diff › comments › src/auth.ts:2")).toMatch(/▶ 2 \+ const ttl = Number/)
    await run("leave")
    await frame("1 comment · 1 replied")
  } finally { await dispose() }
})

test("a asks the small model about a line in a hidden session of its own, streams the answer under it, and x dismisses it", async () => {
  const { frame, run, write, prompts, created, interrupted, stream, view, dispose } = await setup()
  try {
    await frame("const ttl = Number(env.TTL ?? 3600)")
    await run("down", "down", "down", "ask")
    await frame("Ask the small model about line 2")
    await write("Why read env here?")
    await frame("ask line 2 · Claude Haiku · waiting")

    // One archived session, on OpenCode's small model, that can only read, marked as working for this one.
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      archived: true, model: { id: "claude-haiku", providerID: "anthropic" }, location: { directory: "/repo" },
      metadata: { "opcode.side": { parentID: SESSION, plugin: ID } },
    })
    expect(created[0]!.permissions).toContainEqual({ action: "*", resource: "*", effect: "deny" })
    expect(created[0]!.permissions).toContainEqual({ action: "read", resource: "*", effect: "allow" })
    // The question goes there with the diff around the line, never to the agent's session.
    expect(prompts).toHaveLength(1)
    const asked = prompts[0]!
    expect(asked.sessionID).toBe("ses_side1")
    expect(asked.text).toContain("About src/auth.ts:2:")
    expect(asked.text).toContain(">    2 +const ttl = Number(env.TTL ?? 3600)")
    expect(asked.text).toContain("Don't edit anything.")
    expect(asked.text).toEndWith("Why read env here?")

    const question = { id: asked.id!, type: "user", text: asked.text, metadata: asked.metadata, time: { created: 1 } }
    const reply = (text: string) => ({ id: "msg_answer", type: "assistant", agent: "build", model: { id: "claude-haiku", providerID: "anthropic" }, time: { created: 2 },
      content: [{ type: "tool", name: "read" }, { type: "text", text }] })
    stream("ses_side1", [question, reply("TTL comes from")] as SessionMessageInfo[], true)
    expect(await frame("answering... · looked with read")).toContain("TTL comes from")
    stream("ses_side1", [question, reply("TTL comes from the environment so ops can tune it.")] as SessionMessageInfo[], false)
    expect(await frame("ask line 2 · Claude Haiku · answered")).toContain("TTL comes from the environment so ops can tune it.")

    // A follow-up shares the session, without the instructions again.
    await run("down", "ask")
    await write("Is zero handled?")
    expect(created).toHaveLength(1)
    expect(prompts[1]).toMatchObject({ sessionID: "ses_side1" })
    expect(prompts[1]!.text).not.toContain("Don't edit anything.")

    // Dismissing the one being answered stops it.
    stream("ses_side1", [question, reply("TTL comes from the environment so ops can tune it."), { ...question, id: prompts[1]!.id!, metadata: prompts[1]!.metadata }] as SessionMessageInfo[], true)
    await frame("ask line 3 · Claude Haiku · thinking...")
    await run("delete")
    await view.waitForFrame((current) => !current.includes("Is zero handled?"))
    expect(interrupted).toEqual(["ses_side1"])
    await run("up", "delete")
    await view.waitForFrame((current) => !current.includes("TTL comes from the environment"))
    expect(interrupted).toEqual(["ses_side1"])
  } finally { await dispose() }
})

test("esc leaves a question unasked", async () => {
  const { frame, run, view, prompts, created, dispose } = await setup()
  try {
    await frame("const ttl = Number(env.TTL ?? 3600)")
    await run("down", "down", "down", "ask")
    await frame("Ask the small model about line 2")
    await view.mockInput.typeText("Never mind")
    await run("editor.save")
    await view.waitForFrame((current) => !current.includes("Ask the small model"))
    expect(prompts).toHaveLength(0)
    expect(created).toHaveLength(0)
  } finally { await dispose() }
})

test("an agent working in a worktree of its own is reviewed there, as Uncommitted, and the options pick another checkout", async () => {
  const { frame, run, write, choose, stream, diffs, prompts, dispose } = await setup(90, { worktrees: { listed: ["/repo", "/wt/feature"], found: ["/wt/late"] } })
  const working = (tool: Record<string, unknown>) => [{ id: "msg_work", type: "assistant", agent: "build", model: { id: "m", providerID: "p" }, time: { created: 1 },
    content: [{ type: "tool", id: "t", name: tool.name, time: { created: 1 }, state: { status: "completed", input: tool.input, content: [{ type: "text", text: "" }] } }] }] as SessionMessageInfo[]
  try {
    await frame("Review This turn")
    // The session stays in /repo, but its agent runs its commands in a worktree: the snapshots there show nothing.
    stream(SESSION, working({ name: "shell", input: { command: "bun test", workdir: "/wt/feature" } }), true)
    await frame("Review Uncommitted in feature")
    expect(diffs.at(-1)).toEqual({ mode: "working", directory: "/wt/feature" })
    // The agent is told which checkout the line numbers are from.
    await run("down", "down", "down", "comment")
    await write("Guard zero")
    await run("send")
    expect(prompts.at(-1)!.text).toContain("(Uncommitted in feature)")

    // A worktree made outside OpenCode is found by looking again.
    stream(SESSION, working({ name: "edit", input: { path: "/wt/late/src/auth.ts" } }), true)
    await frame("Review Uncommitted in late")
    expect(diffs.at(-1)).toEqual({ mode: "working", directory: "/wt/late" })

    // Picking the session's own directory brings back its views, and "where the agent works" follows it again.
    choose("worktree", "/repo")
    await run("options")
    await settle()
    await frame("Review This turn")
    choose("worktree", "auto")
    await run("options")
    await settle()
    await frame("Review Uncommitted in late")
  } finally { await dispose() }
})
