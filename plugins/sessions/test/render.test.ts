import { afterAll, beforeAll, expect, test } from "bun:test"
import solidPlugin from "@opentui/solid/bun-plugin"
import { testRender } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { mockTheme, tempDir } from "@opcode/ui/test-support/host"
import { createBrowser } from "../src/browser"
import type { SearchOutput, SessionResult } from "../src/domain"
import { record, remoteStub } from "./fixtures"
import type { SessionsView } from "../src/view"

const directory = tempDir("opcode-sessions-render-")
let compiled: { SessionsView: typeof SessionsView }
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("../src/view.tsx", import.meta.url).pathname], outdir: directory.path, target: "bun", format: "esm",
    plugins: [{ name: "host-peers", setup(builder) {
      builder.onResolve({ filter: /^(?:@opencode\/|@opentui\/|solid-js(?:\/|$))/ }, (args) => ({ path: Bun.resolveSync(args.path, args.resolveDir), external: true }))
    } }, solidPlugin],
  })
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the sessions view")
  compiled = await import(build.outputs[0]!.path) as { SessionsView: typeof SessionsView }
})
afterAll(() => directory.remove())

function row(index: number, overrides: Partial<SessionResult> = {}): SessionResult {
  return { ...record(`row-${index}`), updatedAt: Date.now() - 3_600_000, snippet: `Preview ${index}`, providerID: "test", modelID: `model-${index}`, messageCount: 1, modelCount: 1, cost: 1.11, input: 111, output: 22, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...overrides }
}

async function render(search: () => SearchOutput, size = { width: 120, height: 30 }) {
  const model = createBrowser({ session: { list: async () => ({ data: [], cursor: {} }) }, message: { list: async () => ({ data: [], cursor: {} }) } }, remoteStub({ search: async () => search() }))
  const api = {
    renderer: { widthMethod: "unicode" },
    keymap: { mode: { push: () => () => {} } }, ui: { format: { path: (path: string) => path } },
    theme: mockTheme(),
  } as unknown as Context
  await model.filters({ showSubagents: true })
  const view = await testRender(() => PluginContextProvider({ value: api, get children() { return compiled.SessionsView({ model, currentSession: () => "row-0" }) } }), size)
  await view.flush()
  const frame = () => view.captureCharFrame()
  return { model, view, frame, async [Symbol.asyncDispose]() { await view.dispose(); await model.dispose() } }
}

test("header, filters, markers, Unicode titles, and the selected preview render together", async () => {
  const rows = Array.from({ length: 3 }, (_, index) => row(index))
  rows[0]!.title += " 研究 👩‍💻"
  rows[1]!.parentID = "row-0"
  await using ui = await render(() => ({ rows, projects: [], truncated: false }))
  const lines = ui.frame().split("\n")
  const header = lines.find((line) => line.includes("All sessions"))!
  expect(header.indexOf("/ search")).toBeGreaterThan(header.indexOf("across OpenCode projects"))
  const filters = lines.find((line) => line.includes("query:"))!
  for (const text of ["query: .*", "project: all projects", "subagents: shown", "3 sessions"]) expect(filters).toContain(text)
  expect(lines.some((line) => line.includes("test/model-0") && line.includes("111 in") && line.includes("$1.11"))).toBe(true)
  for (const text of ["1 indexed messages", "Preview 0", "研究", "👩‍💻", "[current]", "[subagent]"]) expect(ui.frame()).toContain(text)
  // Recorded totals only: no context-occupancy claim.
  expect(ui.frame()).not.toContain("%")
  expect(lines.find((line) => line.includes("Search indexes session titles"))!.trimEnd().endsWith("alpha")).toBe(true)
  const spans = ui.view.captureSpans().lines.flatMap((line) => line.spans)
  expect(spans.some((span) => span.text.includes("Session row-0") && (span.attributes & TextAttributes.BOLD) !== 0)).toBe(true)
})

test("the viewport follows the selection and the preview shows the selected row's values", async () => {
  const rows = Array.from({ length: 40 }, (_, index) => row(index, index === 35 ? { directory: "/work/bravo", cost: 35.35, input: 3535, snippet: "Preview selected" } : {}))
  await using ui = await render(() => ({ rows, projects: [], truncated: false }))
  for (let index = 0; index < 35; index++) ui.model.move(1)
  await ui.view.flush()
  expect(ui.frame()).toContain("> Session row-35")
  expect(ui.frame()).not.toContain("Session row-0 ")
  expect(ui.frame()).toMatch(/Session row-35[^\n]*bravo\s+1h/)
  for (const text of ["$35.35", "3,535", "Preview selected"]) expect(ui.frame()).toContain(text)
  expect(ui.frame()).not.toContain("Preview 0")
  // Selected title and summary share one row surface, distinct from unselected rows.
  const line = (text: string) => ui.view.captureSpans().lines.find((item) => item.spans.some((span) => span.text.includes(text)))!
  const selected = line("> Session row-35").spans.filter((span) => span.text.includes("Session row-35") || span.text.includes("bravo"))
  const other = line("Session row-34").spans.filter((span) => span.text.includes("Session row-34"))
  expect(selected.some((span) => span.text.includes("bravo"))).toBe(true)
  expect(new Set(selected.map((span) => `${span.bg}`)).size).toBe(1)
  expect(`${selected[0]!.bg}`).not.toBe(`${other[0]!.bg}`)
})

test("selection follows its session through reorder and shrink, then resize hides the preview", async () => {
  let rows = Array.from({ length: 40 }, (_, index) => row(index))
  await using ui = await render(() => ({ rows, projects: [], truncated: false }))
  for (let index = 0; index < 35; index++) ui.model.move(1)
  rows = [{ ...rows[35]!, title: "Reordered selection", cost: 66.66, input: 6666, snippet: "Reordered preview" }, rows[0]!]
  await ui.model.load()
  await ui.view.flush()
  for (const text of ["> Reordered selection", "$66.66", "6,666", "Reordered preview"]) expect(ui.frame()).toContain(text)
  rows = [{ ...rows[1]!, title: "Remaining session", cost: 77.77, input: 7777, snippet: "Remaining preview" }]
  await ui.model.load()
  await ui.view.flush()
  for (const text of ["> [current] Remaining session", "$77.77", "7,777", "Remaining preview"]) expect(ui.frame()).toContain(text)
  expect(ui.frame()).not.toContain("Reordered preview")
  ui.view.resize(90, 18)
  await ui.view.flush()
  expect(ui.frame()).toContain("> [current] Remaining session")
  expect(ui.frame()).not.toContain("indexed messages")
  expect(ui.frame()).not.toContain("Remaining preview")
  expect(ui.frame()).toMatch(/Remaining session[^\n]*alpha\s+1h/)
})

test("empty, partial, and invalid searches are explained", async () => {
  let output: SearchOutput = { rows: [], projects: [], truncated: false }
  await using ui = await render(() => output)
  expect(ui.frame()).toContain("No matching sessions")
  expect(ui.frame()).toContain("0 sessions")
  output = { rows: [row(0)], projects: [], truncated: true }
  await ui.model.load()
  await ui.view.flush()
  expect(ui.frame()).toContain("1+ sessions (partial")
  await ui.model.filters({ query: "[" })
  await ui.view.flush()
  expect(ui.frame()).toContain("Search unavailable")
  expect(ui.frame()).toContain("query: [")
})
