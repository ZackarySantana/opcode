import { expect, test } from "bun:test"
import solidPlugin from "@opentui/solid/bun-plugin"
import { testRender } from "@opentui/solid"
import { RGBA, TextAttributes } from "@opentui/core"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBrowser } from "../src/browser"
import type { SessionResult } from "../src/domain"
import { record, remoteStub } from "./fixtures"
import type { SessionsView } from "../src/view"

test("original-style shared browser preserves layout, selected previews, viewport, Unicode, and resize", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opcode-sessions-render-"))
  let rows: SessionResult[] = Array.from({ length: 40 }, (_, index) => ({ ...record(`row-${index}`), updatedAt: Date.now() - 3_600_000, snippet: index === 35 ? "Preview selected" : "Preview first", providerID: "test", modelID: `model-${index}`, messageCount: 1, modelCount: 1, cost: index === 35 ? 35.35 : 1.11, input: index === 35 ? 3535 : 111, output: 22, reasoning: 0, cacheRead: 0, cacheWrite: 0 }))
  rows[0]!.title += " 研究 👩‍💻"
  rows[1]!.parentID = "row-0"
  rows[35]!.directory = "/work/bravo"
  const model = createBrowser({ session: { list: async () => ({ data: [], cursor: {} }) }, message: { list: async () => ({ data: [], cursor: {} }) } }, remoteStub({ search: async () => ({ rows, projects: [] }) }))
  const api = {
    renderer: { widthMethod: "unicode" },
    keymap: { mode: { push: () => () => {} } }, ui: { format: { path: (path: string) => path } },
    theme: {
      hue: { accent: { 300: "#77cccc", 600: "#336666" }, interactive: { 300: "#55aaff" } },
      background: { base: "#101010", raised: { base: "#202020" }, action: { primary: { selected: "#0055cc" } } },
      border: { base: "#555555" },
      text: { base: "#ffffff", muted: "#aaaaaa", action: { primary: { base: "#55aaff", selected: "#ffffff" }, secondary: { base: "#aaaaee" } }, feedback: { success: { base: "#00ff00" }, error: { base: "#ff5555" } } },
    },
  } as unknown as Context
  try {
    const build = await Bun.build({
      entrypoints: [new URL("../src/view.tsx", import.meta.url).pathname], outdir: directory, target: "bun", format: "esm",
      plugins: [{ name: "host-peers", setup(builder) {
        builder.onResolve({ filter: /^(?:@opencode\/|@opentui\/|solid-js(?:\/|$))/ }, (args) => ({ path: Bun.resolveSync(args.path, args.resolveDir), external: true }))
      } }, solidPlugin],
    })
    expect(build.success).toBe(true)
    const compiled = await import(build.outputs[0]!.path) as { SessionsView: typeof SessionsView }
    await model.filters({ showSubagents: true })
    const view = await testRender(() => PluginContextProvider({ value: api, get children() { return compiled.SessionsView({ model, currentSession: () => "row-0" }) } }), { width: 120, height: 30 })
    try {
      await view.flush()
      const initial = view.captureCharFrame()
      const lines = initial.split("\n")
      const header = lines.find((line) => line.includes("All sessions"))!
      expect(header).toContain("across OpenCode projects")
      expect(header).toContain("/ search")
      expect(header.indexOf("/ search")).toBeGreaterThan(header.indexOf("across OpenCode projects"))
      const filters = lines.find((line) => line.includes("query:"))!
      expect(filters).toContain("query: .*")
      expect(filters).toContain("project: all projects")
      expect(filters).toContain("subagents: shown")
      expect(filters).toContain("40 sessions")
      expect(lines.some((line, index) => index > lines.indexOf(filters) && (line.match(/[┌╭]/g) ?? []).length === 2)).toBe(true)
      expect(lines.some((line) => line.includes("test/model-0") && line.includes("111 in") && line.includes("$1.11"))).toBe(true)
      expect(initial).toContain("1 indexed messages")
      expect(initial).toContain("Preview first")
      expect(initial).toContain("研究")
      expect(initial).toContain("👩‍💻")
      expect(initial).toContain("[current]")
      expect(initial).toContain("[subagent]")
      expect(initial).not.toContain("%")
      const footer = lines.find((line) => line.includes("Search indexes session titles"))!
      expect(footer.trimEnd().endsWith("alpha")).toBe(true)
      const spans = view.captureSpans().lines.flatMap((line) => line.spans)
      expect(spans.some((span) => span.bg.equals(RGBA.fromHex("#202020")))).toBe(true)
      expect(spans.some((span) => span.text.includes("All sessions") && span.fg.equals(RGBA.fromHex("#77cccc")))).toBe(true)
      expect(spans.some((span) => span.text.includes("$1.11") && span.fg.equals(RGBA.fromHex("#55aaff")))).toBe(true)
      expect(spans.some((span) => span.text.includes("Session row-0") && (span.attributes & TextAttributes.BOLD) !== 0)).toBe(true)
      for (let index = 0; index < 35; index++) model.move(1)
      await view.flush()
      expect(view.captureCharFrame()).toContain("> Session row-35")
      expect(view.captureCharFrame()).not.toContain("Session row-0 ")
      expect(view.captureCharFrame()).toMatch(/Session row-35[^\n]*bravo\s+1h/)
      expect(view.captureCharFrame()).toContain("$35.35")
      expect(view.captureCharFrame()).toContain("3,535")
      expect(view.captureCharFrame()).toContain("Preview selected")
      expect(view.captureCharFrame()).not.toContain("Preview first")
      const selectedLine = view.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes("> Session row-35")))!
      const selectedSpans = selectedLine.spans.filter((span) => span.text.includes("Session row-35") || span.text.includes("bravo"))
      expect(selectedSpans.length).toBeGreaterThanOrEqual(1)
      expect(selectedSpans.map((span) => span.text).join("")).toMatch(/Session row-35\s+bravo\s+1h/)
      expect(selectedSpans.every((span) => span.bg.equals(RGBA.fromHex("#0055cc")) && span.fg.equals(RGBA.fromHex("#ffffff")))).toBe(true)

      rows = [{ ...rows[35]!, title: "Reordered selection", cost: 66.66, input: 6666, snippet: "Reordered preview" }, rows[0]!]
      await model.load()
      await view.flush()
      expect(view.captureCharFrame()).toContain("> Reordered selection")
      expect(view.captureCharFrame()).toContain("$66.66")
      expect(view.captureCharFrame()).toContain("6,666")
      expect(view.captureCharFrame()).toContain("Reordered preview")
      expect(view.captureCharFrame()).not.toContain("$35.35")

      rows = [{ ...rows[1]!, title: "Remaining session", cost: 77.77, input: 7777, snippet: "Remaining preview" }]
      await model.load()
      await view.flush()
      expect(view.captureCharFrame()).toContain("> [current] Remaining session")
      expect(view.captureCharFrame()).toContain("$77.77")
      expect(view.captureCharFrame()).toContain("7,777")
      expect(view.captureCharFrame()).toContain("Remaining preview")
      expect(view.captureCharFrame()).not.toContain("Reordered preview")
      view.resize(90, 18)
      await view.flush()
      expect(view.captureCharFrame()).toContain("> [current] Remaining session")
      expect(view.captureCharFrame()).not.toContain("indexed messages")
      expect(view.captureCharFrame()).not.toContain("Remaining preview")
      expect(view.captureCharFrame()).toContain("query: .*")
      expect(view.captureCharFrame()).toMatch(/Remaining session[^\n]*alpha\s+1h/)

      view.resize(120, 30)
      rows = []
      await model.load()
      await view.flush()
      expect(view.captureCharFrame()).toContain("No matching sessions")
      expect(view.captureCharFrame()).toContain("0 sessions")
      await model.filters({ query: "[" })
      await view.flush()
      expect(view.captureCharFrame()).toContain("Search unavailable")
      expect(view.captureCharFrame()).toContain("query: [")
    } finally { await view.dispose() }
  } finally { await model.dispose(); await rm(directory, { recursive: true, force: true }) }
})
