/** @jsxImportSource @opentui/solid */

import { expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { FileDiffInfo } from "@opencode/client"
import { testRender } from "@opentui/solid"
import { Show } from "solid-js"
import { ReviewController } from "../src/host"
import { ReviewPanel } from "../src/panel"
import { patch } from "./fixtures"
import { fakeHost, fakePanel, fastTimer, SESSION, settle } from "./host"

const ID = "opcode-review"
const file = (text = patch): FileDiffInfo => ({ file: "src/auth.ts", patch: text, additions: 3, deletions: 3, status: "modified" })
const other: FileDiffInfo = { file: "src/db.ts", patch: "@@ -1,1 +1,1 @@\n-const pool = 1\n+const pool = 2\n", additions: 1, deletions: 1, status: "modified" }
/** The fixture with two lines added above the ttl change. */
const shifted = () => file(patch.replace(" const user = load()", " const user = load()\n+// one\n+// two").replace("@@ -1,4 +1,5 @@", "@@ -1,4 +1,7 @@"))

async function setup(width = 90) {
  let files = [file(), other]
  const host = fakeHost({ diff: () => files })
  const panel = fakePanel(width)
  const review = new ReviewController(host.api, async () => ({}), Date.now, fastTimer)
  const view = await testRender(() => (
    <PluginContextProvider value={host.api}>
      <Show when={!panel.state.closed}><ReviewPanel panel={panel.input} review={review} /></Show>
    </PluginContextProvider>
  ), { width, height: 40 })
  const frame = (text: string | RegExp) => view.waitForFrame((current) => typeof text === "string" ? current.includes(text) : text.test(current))
  const run = async (...ids: string[]) => { for (const id of ids) { host.dispatch(`${ID}.${id}`); await settle() } }
  const write = async (text: string) => {
    await view.mockInput.typeText(text)
    view.mockInput.pressEnter()
    await settle()
  }
  return {
    ...host, view, frame, run, write, panel, review,
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
