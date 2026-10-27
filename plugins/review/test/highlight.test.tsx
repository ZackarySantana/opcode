/** @jsxImportSource @opentui/solid */

import { expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import { testRender, useRenderer } from "@opentui/solid"
import { ReviewController } from "../src/host"
import { ReviewPanel } from "../src/panel"
import { useSyntax } from "../src/syntax"
import { patch } from "./fixtures"
import { fakeHost, fakePanel, fastTimer, settle } from "./host"

/** The panel drawn with the theme's syntax colors, as the plugin draws it. */
async function setup() {
  const host = fakeHost({ diff: () => [{ file: "src/auth.ts", patch, additions: 3, deletions: 3, status: "modified" }] })
  const panel = fakePanel(80)
  const review = new ReviewController(host.api, { replies: async () => ({}), timer: fastTimer })
  const view = await testRender(() => {
    const syntax = useSyntax({ theme: host.api.theme, renderer: useRenderer() } as never)
    return <PluginContextProvider value={host.api}><ReviewPanel panel={panel.input} review={review} syntax={syntax} /></PluginContextProvider>
  }, { width: 80, height: 24 })
  await settle()
  await settle()
  const run = async (...ids: string[]) => { for (const id of ids) { host.dispatch(`opcode-review.${id}`); await settle() } }
  /** Each span of the diff line showing `text`, with its background, once highlighting has settled. */
  const line = async (text: string) => {
    await Bun.sleep(300)
    await view.renderOnce()
    const index = view.captureCharFrame().split("\n").findIndex((row) => row.includes(text))
    return view.captureSpans().lines[index]!.spans.filter((span) => span.text.trim()).map((span) => ({ text: span.text.trim(), bg: String(span.bg) }))
  }
  return { host, run, line, dispose: async () => { await view.dispose(); review.dispose() } }
}

test("the cursor's line stands apart, its picked name is drawn as selected, and the name's other uses are marked", async () => {
  const { host, run, line, dispose } = await setup()
  try {
    await run("down", "down", "down")
    const cursor = await line("const ttl = Number")
    const below = await line("if (!ttl)")
    const theme = host.api.theme as unknown as { background: { action: { primary: { selected: unknown } } } }
    const bg = (spans: { text: string; bg: string }[], text: string) => spans.find((span) => span.text === text)!.bg
    // Two added lines: the cursor's is a different shade, gutter and text alike.
    expect(bg(cursor, "const")).not.toBe(bg(below, "if"))
    expect(bg(cursor, "2")).toBe(bg(cursor, "const"))
    expect(bg(cursor, "ttl")).toBe(String(theme.background.action.primary.selected))
    // The same name on another line is marked, unlike the words around it.
    expect(bg(below, "ttl")).not.toBe(bg(below, "if"))

    // Moving on moves both: the old line is plain again, and the marks follow the new pick, the name that changed there.
    await run("down")
    const left = await line("const ttl = Number")
    const now = await line("if (!ttl)")
    expect(bg(left, "const")).toBe(bg(below, "if"))
    expect(bg(left, "ttl")).toBe(bg(left, "const"))
    expect(bg(now, "Error")).toBe(String(theme.background.action.primary.selected))
  } finally { await dispose() }
})
