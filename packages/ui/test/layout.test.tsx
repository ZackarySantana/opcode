/** @jsxImportSource @opentui/solid */

import { expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA, TextAttributes, type CapturedFrame } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { Card, CenterEmpty, FilterChip, KeyHints, Page, StatCard, ThemeSurface } from "@opcode/ui"

const colors = {
  background: RGBA.fromHex("#101112"),
  raised: RGBA.fromHex("#242526"),
  border: RGBA.fromHex("#617273"),
  text: RGBA.fromHex("#e0e1e2"),
  muted: RGBA.fromHex("#819293"),
  primary: RGBA.fromHex("#8aafff"),
  accent: RGBA.fromHex("#7ccac4"),
  accentBorder: RGBA.fromHex("#3b6965"),
}

function context(primary = () => colors.primary) {
  return {
    theme: {
      hue: { accent: { 300: colors.accent, 600: colors.accentBorder }, interactive: { get 300() { return primary() } } },
      background: { base: colors.background, raised: { base: colors.raised } },
      border: { base: colors.border },
      text: { base: colors.text, muted: colors.muted, action: { primary: { base: colors.text } } },
    },
  } as unknown as Context
}

function position(frame: string, text: string) {
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  if (y < 0) throw new Error(`Missing ${JSON.stringify(text)} in rendered frame:\n${frame}`)
  return { x: lines[y]!.indexOf(text), y }
}

function cell(frame: CapturedFrame, x: number, y: number) {
  let offset = 0
  for (const span of frame.lines[y]!.spans) {
    if (offset + span.width > x) return span
    offset += span.width
  }
  throw new Error(`Missing rendered cell ${x}, ${y}`)
}

test("page recreates raised stat cards, inline hints, chips, and an anchored footer", async () => {
  const [primary, setPrimary] = createSignal(colors.primary)
  const host = context(primary)
  const view = await testRender(() => (
    <PluginContextProvider value={host}>
      <Page title="Cost ledger" subtitle="all sessions"
        actions={<KeyHints items={[{ key: "esc", label: "back" }, { key: "r", label: "refresh" }]} />}
        filters={<><FilterChip label="date" value="last 30 days" /><FilterChip label="project" value="all projects" /></>}
        footer={<text>Provider-reported costs</text>}>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <StatCard label="Total cost" value="$18.66" detail="123 requests" />
          <StatCard label="All tokens" value="17.8M" detail="4.29M input" />
        </box>
        <Card title="BY MODEL" grow><text>Example model</text></Card>
      </Page>
    </PluginContextProvider>
  ), { width: 90, height: 30 })
  try {
    const frame = await view.waitForFrame((value) => value.includes("Example model"))
    const title = position(frame, "Cost ledger all sessions")
    const hints = position(frame, "esc back  r refresh")
    const label = position(frame, "TOTAL COST")
    const value = position(frame, "$18.66")
    const detail = position(frame, "123 requests")
    expect(title.x).toBe(2)
    expect(title.y).toBe(1)
    expect(hints.y).toBe(title.y)
    expect(hints.x).toBeGreaterThan(title.x + "Cost ledger all sessions".length)
    expect(position(frame, "date: last 30 days").y).toBe(position(frame, "project: all projects").y)
    expect(position(frame, "ALL TOKENS").y).toBe(label.y)
    expect(value).toEqual({ x: label.x, y: label.y + 1 })
    expect(detail).toEqual({ x: label.x, y: label.y + 2 })
    expect(position(frame, "Provider-reported costs").y).toBe(28)
    expect(frame.split("\n")[label.y - 2]).toContain("┌")
    const spans = view.captureSpans()
    expect(cell(spans, label.x, label.y).fg).toEqual(colors.accent)
    expect(cell(spans, value.x, value.y).fg).toEqual(colors.primary)
    expect(cell(spans, value.x, value.y).attributes & TextAttributes.BOLD).toBeTruthy()
    expect(cell(spans, label.x, label.y).bg).toEqual(colors.raised)
    expect(cell(spans, 2, label.y).fg).toEqual(colors.accentBorder)
    expect(cell(spans, title.x, title.y).fg).toEqual(colors.accent)
    expect(cell(spans, title.x + "Cost ledger ".length, title.y).fg).toEqual(colors.muted)
    expect(cell(spans, hints.x, hints.y).fg).toEqual(colors.primary)
    expect(cell(spans, hints.x + 4, hints.y).fg).toEqual(colors.muted)
    const nextPrimary = RGBA.fromHex("#ffbc77")
    setPrimary(nextPrimary)
    await view.renderOnce()
    expect(cell(view.captureSpans(), value.x, value.y).fg).toEqual(nextPrimary)
  } finally { await view.dispose() }
})

test("clickable hints dispatch their keyboard command and ignore other mouse buttons", async () => {
  const commands: string[] = []
  let triggered = 0
  const host = { ...context(), keymap: { dispatch: (id: string) => commands.push(id) } } as unknown as Context
  const view = await testRender(() => (
    <PluginContextProvider value={host}>
      <KeyHints items={[{ key: "r", label: "refresh", command: "example.refresh" }, { key: "l", label: "next", onTrigger: () => { triggered++ } }]} />
    </PluginContextProvider>
  ), { width: 40, height: 3 })
  try {
    const frame = await view.waitForFrame((text) => text.includes("r refresh") && text.includes("l next"))
    const refresh = position(frame, "r refresh")
    await view.mockMouse.click(refresh.x, refresh.y, 2)
    expect(commands).toEqual([])
    await view.mockMouse.click(refresh.x, refresh.y)
    expect(commands).toEqual(["example.refresh"])
    const next = position(frame, "l next")
    await view.mockMouse.click(next.x, next.y)
    expect(triggered).toBe(1)
  } finally { await view.dispose() }
})

test("compact pages wrap header chrome and keep bordered content above the footer after resize", async () => {
  const view = await testRender(() => (
    <PluginContextProvider value={context()}>
      <Page title="All sessions" subtitle="across projects"
        actions={<KeyHints items={[{ key: "/", label: "search" }, { key: "esc", label: "back" }]} />}
        filters={<><FilterChip label="query" value="all" /><FilterChip label="project" value="all projects" /></>}
        footer={<text>Search session titles</text>}>
        <Card title="SESSIONS" grow minHeight={5}>
          <scrollbox flexGrow={1} minHeight={0}>
            {Array.from({ length: 40 }, (_, index) => <text flexShrink={0}>Session {index}</text>)}
          </scrollbox>
        </Card>
      </Page>
    </PluginContextProvider>
  ), { width: 70, height: 24 })
  try {
    await view.waitForFrame((value) => value.includes("Session 0"))
    view.resize(40, 22)
    const frame = await view.waitForFrame((value) => value.includes("Search session titles") && value.split("\n")[20]?.includes("Search session titles") === true)
    expect(frame).toContain("/ search  esc back")
    expect(frame).toContain("query: all")
    expect(frame).toContain("project: all projects")
    expect(frame).toContain("SESSIONS")
    expect(position(frame, "Session 0").y).toBeLessThan(20)
    expect(position(frame, "Search session titles")).toEqual({ x: 2, y: 20 })
    const lines = frame.split("\n")
    expect(lines.some((line, y) => y < 20 && line.includes("└") && line.includes("┘"))).toBe(true)
    for (const line of lines) {
      expect(line.slice(0, 2).trim()).toBe("")
      expect(line.slice(38).trim()).toBe("")
    }
  } finally { await view.dispose() }
})

test("empty states center in the available card body without stretching content cards by default", async () => {
  const view = await testRender(() => (
    <PluginContextProvider value={context()}>
      <Page title="Later" footer={<text>Changes are shared</text>}>
        <Card><text>0 active</text></Card>
        <Card grow><CenterEmpty title="Nothing saved" description="Add a task to begin." /></Card>
      </Page>
    </PluginContextProvider>
  ), { width: 50, height: 26 })
  try {
    const frame = await view.waitForFrame((value) => value.includes("Nothing saved"))
    const title = position(frame, "Nothing saved")
    const description = position(frame, "Add a task to begin.")
    const summary = position(frame, "0 active")
    expect(summary.y).toBeLessThan(title.y - 3)
    expect(title.x).toBeGreaterThan(14)
    expect(title.x).toBeLessThan(21)
    expect(description.y).toBe(title.y + 2)
    expect(title.y).toBeGreaterThan(11)
    expect(title.y).toBeLessThan(18)
    expect(position(frame, "Changes are shared").y).toBe(24)
  } finally { await view.dispose() }
})

test("long chips stay single-line and small stat cards retain zero values", async () => {
  const view = await testRender(() => (
    <PluginContextProvider value={context()}>
      <Page title="Context" filters={<FilterChip label="model" value="a very long model name that must not escape its chip" />}>
        <box flexDirection="row" gap={1}>
          <StatCard label="Input" value={0} />
          <StatCard label="Cache" value="0%" />
        </box>
      </Page>
    </PluginContextProvider>
  ), { width: 34, height: 18 })
  try {
    const frame = await view.waitForFrame((value) => value.includes("INPUT") && value.includes("CACHE"))
    const label = position(frame, "INPUT")
    const lines = frame.split("\n")
    expect(lines[label.y + 1]![label.x]).toBe("0")
    expect(frame).not.toContain("escape its chip")
    const chip = position(frame, "model:")
    expect(lines[chip.y - 1]![2]).toBe("┌")
    expect(lines[chip.y + 1]![2]).toBe("└")
    const spans = view.captureSpans()
    expect(cell(spans, chip.x, chip.y).fg).toEqual(colors.accent)
    expect(cell(spans, chip.x + 7, chip.y).fg).toEqual(colors.text)
    for (const line of lines) expect(line.slice(32).trim()).toBe("")
  } finally { await view.dispose() }
})

test("mounted shared components follow full theme and mode changes, including dialog overrides", async () => {
  const dark = context().theme
  const light = {
    ...dark,
    hue: { accent: { 300: RGBA.fromHex("#285e59"), 600: RGBA.fromHex("#94bdb9") }, interactive: { 300: RGBA.fromHex("#2654a0") } },
    background: { base: RGBA.fromHex("#ffffff"), raised: { base: RGBA.fromHex("#eeeeee") } },
    text: { ...dark.text, base: RGBA.fromHex("#161616"), muted: RGBA.fromHex("#555555") },
  } as Context["theme"]
  const dialogDark = { ...dark, background: { ...dark.background, raised: { ...dark.background.raised, base: RGBA.fromHex("#353535") } }, text: { ...dark.text, muted: RGBA.fromHex("#b3c3c3") } }
  const dialogLight = { ...light, background: { ...light.background, raised: { ...light.background.raised, base: RGBA.fromHex("#dddddd") } }, text: { ...light.text, muted: RGBA.fromHex("#445555") } }
  const [theme, setTheme] = createSignal({ ...dark, surface: () => dialogDark })
  const host = { get theme() { return theme() } } as unknown as Context
  const view = await testRender(() => (
    <PluginContextProvider value={host}>
      <box flexDirection="column">
        <StatCard label="Page" value="12" detail="page detail" />
        <ThemeSurface name="dialog">
          <StatCard label="Dialog" value="34" detail="dialog detail" />
          <KeyHints items={[{ key: "r", label: "refresh" }]} />
        </ThemeSurface>
      </box>
    </PluginContextProvider>
  ), { width: 50, height: 24 })
  try {
    for (const [base, dialog] of [[dark, dialogDark], [light, dialogLight]] as const) {
      setTheme({ ...base, surface: () => dialog })
      await view.renderOnce()
      const frame = view.captureCharFrame()
      const captured = view.captureSpans()
      const at = (text: string) => { const p = position(frame, text); return cell(captured, p.x, p.y) }
      expect(at("PAGE").fg).toEqual(base.hue.accent[300])
      expect(at("12").fg).toEqual(base.hue.interactive[300])
      expect(at("12").bg).toEqual(base.background.raised.base)
      expect(at("DIALOG").fg).toEqual(dialog.hue.accent[300])
      expect(at("34").fg).toEqual(dialog.hue.interactive[300])
      expect(at("34").bg).toEqual(dialog.background.raised.base)
      expect(at("page detail").fg).toEqual(base.text.muted)
      expect(at("dialog detail").fg).toEqual(dialog.text.muted)
      expect(at("r refresh").fg).toEqual(dialog.hue.interactive[300])
    }
  } finally { await view.dispose() }
})
