/** @jsxImportSource @opentui/solid */

import { expect, test } from "bun:test"
import { mockTheme } from "@opcode/ui/test-support/host"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, KeymapCommand, KeymapLayer } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { createComputed, onCleanup } from "solid-js"
import { createBrowser } from "../src/browser"
import { SessionsDialog } from "../src/dialog"
import type { SearchInput, SearchOutput, SessionResult } from "../src/domain"
import { record, remoteStub } from "./fixtures"

function row(index: number, overrides: Partial<SessionResult> = {}): SessionResult {
  return { ...record(`row-${index}`), updatedAt: Date.now() - 3_600_000, snippet: `Preview ${index}`, providerID: "test", modelID: `model-${index}`, messageCount: 1, modelCount: 1, cost: 1.11, input: 111, output: 22, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...overrides }
}

// A large dialog is about 88 cells wide.
async function render(search: (input: SearchInput) => SearchOutput | Promise<SearchOutput>, size = { width: 88, height: 40 }) {
  const model = createBrowser({ session: { list: async () => ({ data: [], cursor: {} }) }, message: { list: async () => ({ data: [], cursor: {} }) } }, remoteStub({ search: async (input) => search(input) }))
  // Layers leave with their owner, as in the host, so a stale command from an unmounted list or picker can't run.
  const layers = new Set<() => KeymapLayer>()
  const dispatch = (id: string) => [...layers].map((layer) => layer()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .flatMap((layer) => (layer.commands ?? []) as KeymapCommand[])
    .find((command) => command.id === id && (typeof command.enabled === "function" ? command.enabled() : command.enabled ?? true))?.run()
  const events: string[] = []
  const host = {
    theme: mockTheme(),
    renderer: { widthMethod: "unicode", once() {}, off() {}, requestRender() {} },
    ui: { dialog: { clear: () => events.push("clear") }, format: { path: (path: string) => path }, router: { current: () => ({ type: "session", sessionID: "row-0" }) } },
    keymap: {
      dispatch,
      layer: (factory: () => KeymapLayer) => {
        let current: KeymapLayer = {}
        const layer = () => current
        createComputed(() => { current = factory() })
        layers.add(layer)
        onCleanup(() => layers.delete(layer))
      },
    },
  } as unknown as Context
  await model.activate()
  const view = await testRender(() => <PluginContextProvider value={host}><SessionsDialog model={model} open={(id) => events.push(`open ${id}`)} /></PluginContextProvider>, size)
  const frame = (check: (frame: string) => boolean) => view.waitForFrame(check)
  return {
    model, view, events, frame,
    run: (name: string) => dispatch(`opcode-sessions.${name}`),
    async [Symbol.asyncDispose]() { await view.dispose(); await model.dispose() },
  }
}

test("rows, markers, and the selected row's preview render; the list scrolls with the selection; narrow dialogs drop the preview", async () => {
  const rows = Array.from({ length: 40 }, (_, index) => row(index, index === 35 ? { directory: "/work/bravo", cost: 35.35, input: 3535, snippet: "Preview selected" } : {}))
  rows[0]!.title += " 研究 👩‍💻"
  rows[1]!.parentID = "row-0"
  await using ui = await render(() => ({ rows, projects: [], truncated: false }))
  await ui.run("subagents")
  const first = await ui.frame((frame) => frame.includes("Preview 0"))
  for (const text of ["All sessions", "40 sessions · subagents shown", "研究", "👩‍💻", "[current]", "[subagent]", "1 indexed messages", "/work/alpha"]) expect(first).toContain(text)
  expect(first.split("\n").some((line) => line.includes("test/model-0") && line.includes("111 in") && line.includes("$1.11"))).toBe(true)
  // Recorded totals only: no context-occupancy claim.
  expect(first).not.toContain("%")

  for (let index = 0; index < 35; index++) ui.run("down")
  const moved = await ui.frame((frame) => frame.includes("Preview selected"))
  for (const text of ["> Session row-35", "$35.35", "3,535"]) expect(moved).toContain(text)
  expect(moved).not.toContain("Session row-0 ")

  ui.view.resize(70, 30)
  await ui.frame((frame) => frame.includes("> Session row-35") && !frame.includes("indexed messages"))
})

test("the box searches as you type, p narrows to a project, esc steps back before closing, and enter opens after closing", async () => {
  const projects = [{ id: "alpha", directory: "/work/alpha", label: "alpha" }, { id: "bravo", directory: "/work/bravo", label: "bravo" }]
  const rows = [row(1, { title: "Cache design" }), row(2, { title: "Billing", directory: "/work/bravo", projectID: "bravo" }), row(3, { title: "Cache review", directory: "/work/bravo", projectID: "bravo" })]
  let hold: Promise<void> | undefined
  await using ui = await render(async (input) => {
    await hold
    return { rows: rows.filter((row) => new RegExp(input.query, "i").test(row.title) && (!input.projectID || row.projectID === input.projectID)), projects, truncated: false }
  })
  await ui.frame((frame) => frame.includes("Billing"))

  // Enter in the box never opens a row left over from the previous query.
  const gate = Promise.withResolvers<void>()
  hold = gate.promise
  ui.run("search")
  await ui.view.mockInput.typeText("^cache")
  await ui.view.mockInput.pressEnter()
  expect(ui.events).toEqual([])
  gate.resolve()
  await ui.frame((frame) => frame.includes("Cache review") && !frame.includes("Billing"))
  ui.run("close")
  expect(ui.model.state().query).toBe("^cache")

  // The picker uses the box, so the search starts over.
  ui.run("project")
  await ui.frame((frame) => frame.includes("All projects"))
  ui.run("down")
  ui.run("down")
  ui.run("activate")
  const narrowed = await ui.frame((frame) => frame.includes("bravo ›") && frame.includes("Billing"))
  expect(narrowed).not.toContain("Cache design")
  expect(ui.model.state()).toMatchObject({ query: "", projectID: "bravo" })

  ui.run("close")
  await ui.frame((frame) => frame.includes("Cache design") && !frame.includes("bravo ›"))
  expect(ui.events).toEqual([])
  ui.run("close")
  expect(ui.events).toEqual(["clear"])

  ui.run("down")
  ui.run("activate")
  expect(ui.events).toEqual(["clear", "clear", `open ${rows[1]!.id}`])
})

test("empty, partial, and invalid searches are explained", async () => {
  let output: SearchOutput = { rows: [], projects: [], truncated: false }
  await using ui = await render(() => output)
  await ui.frame((frame) => frame.includes("No matching sessions") && frame.includes("0 sessions"))
  output = { rows: [row(0)], projects: [], truncated: true }
  await ui.model.load()
  await ui.frame((frame) => frame.includes("1+ sessions · subagents hidden · partial"))
  ui.run("search")
  await ui.view.mockInput.typeText("[")
  await ui.frame((frame) => frame.includes("Search unavailable"))
})
