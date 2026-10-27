/** @jsxImportSource @opentui/solid */

import { expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { FileDiffInfo } from "@opencode/client"
import { testRender } from "@opentui/solid"
import { Show } from "solid-js"
import { ReviewController } from "../src/host"
import { ReviewPanel } from "../src/panel"
import type { Found, Lookup, LspConfig } from "../src/references"
import { fakeHost, fakePanel, fastTimer, settle } from "./host"

const ID = "opcode-review"
// The agent gave readJson a new parameter and updated one caller, but not the one in load.ts.
const json: FileDiffInfo = {
  file: "src/json.ts", additions: 1, deletions: 1, status: "modified",
  patch: "@@ -1,3 +1,3 @@\n-export function readJson(p: string) {\n+export function readJson(p: string, strict: boolean) {\n   return parse(p)\n }\n",
}
const store: FileDiffInfo = {
  file: "src/store.ts", additions: 1, deletions: 1, status: "modified",
  patch: "@@ -1,2 +1,2 @@\n import { readJson } from \"./json\"\n-const raw = readJson(path)\n+const raw = readJson(path, true)\n",
}
const load = Array.from({ length: 30 }, (_, index) => index === 20 ? "const cfg = readJson(file)" : `// line ${index + 1}`).join("\n") + "\n"
const usages: Found = {
  engine: "lsp", server: "typescript", truncated: false,
  places: [
    { file: "src/json.ts", line: 1, column: 16, text: "export function readJson(p: string, strict: boolean) {" },
    { file: "src/store.ts", line: 1, column: 9, text: "import { readJson } from \"./json\"" },
    { file: "src/store.ts", line: 2, column: 12, text: "const raw = readJson(path, true)" },
    { file: "src/load.ts", line: 21, column: 12, text: "const cfg = readJson(file)" },
  ],
}

async function setup(answers: { usages?: Found; definition?: Found } = {}) {
  const host = fakeHost({ diff: () => [json, store], files: { "src/load.ts": load }, lsp: { typescript: { command: ["tsls", "--stdio"] } } })
  const panel = fakePanel(90)
  const asked: { kind: string; lookup: Lookup; lsp: LspConfig | null }[] = []
  let hold: Promise<void> | undefined
  const review = new ReviewController(host.api, {
    replies: async () => ({}), timer: fastTimer,
    symbols: async (kind, lookup, lsp, _directory, signal) => {
      asked.push({ kind, lookup, lsp })
      await hold
      signal.throwIfAborted()
      return (kind === "usages" ? answers.usages : answers.definition) ?? { engine: "search", places: [], truncated: false }
    },
  })
  const view = await testRender(() => <PluginContextProvider value={host.api}><Show when={!panel.state.closed}><ReviewPanel panel={panel.input} review={review} /></Show></PluginContextProvider>, { width: 90, height: 40 })
  const frame = (text: string | RegExp) => view.waitForFrame((current) => typeof text === "string" ? current.includes(text) : text.test(current))
  const run = async (...ids: string[]) => { for (const id of ids) { host.dispatch(`${ID}.${id}`); await settle() } }
  /** Holds lookups until the returned function is called. */
  const holdLookups = () => { let release!: () => void; hold = new Promise((resolve) => { release = resolve }); return () => { hold = undefined; release() } }
  return { ...host, view, frame, run, asked, holdLookups, panel, dispose: async () => { await view.dispose(); review.dispose() } }
}

test("usages of the name a changed line defines show where the diff may have missed a caller", async () => {
  const { frame, run, asked, dispose } = await setup({ usages })
  try {
    await frame("readJson(p: string, strict: boolean)")
    await run("down")
    // The names on the line, keywords and types left out; the one the added line defines is picked.
    expect(await frame(/▶ 1 \+ export function readJson/)).toMatch(/h\/l\s+readJson\s+p\s+strict\s*\n/)
    await run("usages")
    const list = await frame("Usages of readJson")
    expect(asked[0]).toMatchObject({ kind: "usages", lookup: { file: "src/json.ts", line: 1, name: "readJson" } })
    // The language servers OpenCode is set up with go along, merged from its config files.
    expect(asked[0]!.lsp).toEqual({ typescript: { command: ["tsls", "--stdio"] } })
    expect(list).toContain("via typescript")
    expect(list).toContain("4 places · 3 in the diff · 1 outside")
    expect(list).toContain("⚠ signature changed")
    expect(list).toMatch(/src\/load\.ts\s+not changed by the agent/)
    expect(list).toMatch(/21\s+const cfg = readJson\(file\)\s+⚠ not updated\?/)
    expect(list).not.toMatch(/readJson\(path, true\)\s+⚠/)

    // Only what's outside the diff.
    await run("list.scope", "list.scope")
    const outside = await frame("[Outside]")
    expect(outside).not.toContain("src/store.ts")
    expect(outside).toContain("const cfg = readJson(file)")
  } finally { await dispose() }
})

test("a usage in the diff opens on its row; one outside opens the file, where a comment is marked outside the diff", async () => {
  const { frame, run, view, prompts, dispose } = await setup({ usages })
  try {
    await frame("readJson(p: string, strict: boolean)")
    await run("down", "usages")
    await frame("4 places")
    await run("list.down", "list.down", "list.open")
    expect(await frame("← diff › usages of readJson › src/store.ts:2")).toMatch(/▶ 2 \+ const raw = readJson\(path, true\)/)

    // n steps to the next usage without going back to the list.
    await run("result.next")
    const outside = await frame("Read-only")
    expect(outside).toContain("src/load.ts:21")
    expect(outside).toMatch(/▶ 21\s+const cfg = readJson\(file\)/)
    await run("comment")
    await frame("New comment on line 21 (outside the diff)")
    await view.mockInput.typeText("Pass strict here too")
    view.mockInput.pressEnter()
    await frame("r1 line 21 (outside the diff) · draft")

    // Escape walks back: the list, then the diff, where escape sends and closes.
    await run("leave")
    await frame("Usages of readJson")
    await run("list.back")
    await frame(/1\/2 src\/json\.ts/)
    await run("send")
    expect(prompts[0]!.text).toContain("[r1] src/load.ts:21 (outside the diff)")
  } finally { await dispose() }
})

test("a single definition opens directly, and search only skips the language server", async () => {
  const definition: Found = { engine: "search", truncated: false, places: [{ file: "src/load.ts", line: 21, column: 6, text: "const cfg = readJson(file)" }] }
  const { frame, run, choose, asked, dispose } = await setup({ definition })
  try {
    await frame("readJson(p: string, strict: boolean)")
    choose("refs:search")
    await run("options")
    await run("down", "definition")
    expect(asked.at(-1)).toMatchObject({ kind: "definition", lsp: null })
    expect(await frame("Read-only")).toMatch(/▶ 21\s+const cfg = readJson\(file\)/)
  } finally { await dispose() }
})

test("a lookup interrupted by closing the panel runs again on reopening, and a removed line is only ever searched", async () => {
  const { frame, run, asked, holdLookups, panel, dispose } = await setup({ usages, definition: { engine: "search", truncated: false, places: [] } })
  try {
    await frame("readJson(p: string, strict: boolean)")
    const release = holdLookups()
    // The removed definition line: no file has it any more.
    await run("usages")
    await frame("Looking for readJson...")
    expect(asked[0]).toMatchObject({ kind: "usages", lsp: null })
    panel.set("closed", 1)
    release()
    panel.set("closed", 0)
    await frame("4 places")
    expect(asked).toHaveLength(2)

    // Its definition is searched for too, never asked of a language server at a line that no longer has the name.
    await run("list.definition")
    await frame("No definition found.")
    expect(asked.at(-1)).toMatchObject({ kind: "definition", lsp: null })
  } finally { await dispose() }
})
