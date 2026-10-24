/** @jsxImportSource @opentui/solid */

import { expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import { testRender } from "@opentui/solid"
import { ScrollBoxRenderable } from "@opentui/core"
import { Show } from "solid-js"
import { isDashboardRoute, PLUGIN_ID, ROUTE } from "../src/navigation.js"
import { createTuiHarness, dashboard } from "./tui-harness.js"

const destination = (range: string, projectID?: string, model?: string) => ({
  type: "plugin" as const, id: PLUGIN_ID, name: ROUTE, data: { range, projectID, model },
})

async function renderDashboard(harness: Awaited<ReturnType<typeof createTuiHarness>>, height = 32, width = 72, availableHeight = height) {
  const Page = () => harness.page().render({
    get data() {
      const route = harness.route()
      return route.type === "plugin" ? route.data : undefined
    },
  })
  return testRender(() => (
    <PluginContextProvider value={harness.api as never}>
      <box width="100%" height={availableHeight}>
        <Show when={isDashboardRoute(harness.route())}><Page /></Show>
      </box>
    </PluginContextProvider>
  ), { width, height })
}

test.each([
  { width: 144, height: 40, availableHeight: 40 },
  { width: 100, height: 32, availableHeight: 32 },
  { width: 144, height: 40, availableHeight: 32 },
])("empty dashboard does not manufacture scroll space at $width columns ($availableHeight available rows)", async ({ width, height, availableHeight }) => {
  const harness = await createTuiHarness(destination("30d"))
  const scene = await renderDashboard(harness, height, width, availableHeight)
  try {
    await scene.waitFor(() => harness.queries.length > 0)
    const empty = dashboard(0)
    empty.total = { cost: 0, messages: 0, tokens: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    empty.models = []; empty.projects = []; empty.daily = []
    harness.queries.at(-1)!.resolve(empty)
    const frame = await scene.waitForFrame((text) => text.includes("No recorded usage"))
    const scroll = scene.renderer.root.findDescendantById("opcode-cost.content")
    if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing cost scroll viewport")
    expect(frame).toContain("TOTAL COST")
    expect(frame).toContain("Provider-reported USD")
    expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.viewport.height)
    expect(scroll.verticalScrollBar.visible).toBe(false)
    await scene.mockInput.pressKeys(Array(20).fill("ARROW_DOWN"), 0)
    await scene.flush()
    expect(scroll.scrollTop).toBe(0)
  } finally { await scene.dispose(); await harness.cleanup() }
})

test("history reconciliation runs silently without moving the dashboard", async () => {
  const harness = await createTuiHarness(destination("30d"))
  const scene = await renderDashboard(harness, 40, 144)
  const history = Promise.withResolvers<{ data: never[]; cursor: {} }>()
  let refreshing: Promise<void> | undefined
  try {
    await scene.waitFor(() => harness.queries.length > 0)
    harness.queries.at(-1)!.resolve(dashboard())
    const before = await scene.waitForFrame((text) => text.includes("TOTAL COST"))
    const totalsRow = before.split("\n").findIndex((line) => line.includes("TOTAL COST"))
    let importing = false
    harness.api.client.session.list = () => { importing = true; return history.promise }
    refreshing = harness.run("refresh")
    await scene.waitFor(() => importing)
    await scene.flush()
    const during = scene.captureCharFrame()
    expect(during).not.toContain("Reconciling")
    expect(during.split("\n").findIndex((line) => line.includes("TOTAL COST"))).toBe(totalsRow)
    history.resolve({ data: [], cursor: {} })
    await refreshing
    await scene.flush()
    expect(scene.captureCharFrame().split("\n").findIndex((line) => line.includes("TOTAL COST"))).toBe(totalsRow)
  } finally {
    history.resolve({ data: [], cursor: {} })
    await refreshing
    await scene.dispose()
    await harness.cleanup()
  }
})

test("import failures belong to their location; switching cancels the old import, and r retries the current one", async () => {
  const harness = await createTuiHarness(destination("30d"))
  const scene = await renderDashboard(harness, 40, 144)
  const failure = "History import failed: offline. Press r to retry."
  try {
    await scene.waitFor(() => harness.queries.length > 0)
    harness.queries.at(-1)!.resolve(dashboard())
    // A transport that ignores cancellation, failing only after the location changed.
    const late = Promise.withResolvers<never>()
    const listed = Promise.withResolvers<AbortSignal>()
    harness.api.client.session.list = ((_input: unknown, options: { signal: AbortSignal }) => {
      listed.resolve(options.signal)
      return late.promise
    }) as never
    const pending = harness.run("refresh")
    const first = await listed.promise
    harness.api.client.session.list = async () => ({ data: [], cursor: {} })
    harness.setLocation({ directory: "/another/location" })
    expect(first.aborted).toBe(true)
    late.reject(new Error("offline"))
    await pending
    await scene.flush()
    expect(scene.captureCharFrame()).not.toContain("History import failed")

    harness.api.client.session.list = async () => { throw new Error("offline") }
    harness.setLocation({ directory: "/remote/project" })
    await scene.waitForFrame((text) => text.includes(failure))
    harness.api.client.session.list = async () => ({ data: [], cursor: {} })
    await harness.run("refresh")
    await scene.waitForFrame((text) => !text.includes("History import failed"))
  } finally { await scene.dispose(); await harness.cleanup() }
})

test("real narrow dashboard keeps daily activity reachable with both filters, and query labels/totals update reactively", async () => {
  const harness = await createTuiHarness(destination("7d", "p", "provider/model"))
  // At 72 columns the Cost/Time tabs wrap the model chip onto a second filter row.
  const scene = await renderDashboard(harness, 23)
  try {
    await scene.waitFor(() => harness.queries.length > 0)
    const first = harness.queries.at(-1)!
    expect(first.filter).toEqual({ range: "7d", projectID: "p", model: "provider/model" })
    first.resolve(dashboard())
    let frame = await scene.waitForFrame((text) => text.includes("$2.00") && text.includes("Alpha"))
    expect(frame).toContain("last 7 days")
    expect(frame).toContain("provider/model")
    expect(frame).toContain("recorded messages")
    expect(frame).toContain("TOTAL COST")
    expect(frame).toContain("ALL TOKENS")
    expect(frame).not.toContain("BY MODEL")
    expect(frame).not.toContain("BY PROJECT")
    await scene.mockInput.pressKeys(Array(30).fill("ARROW_DOWN"), 0)
    frame = await scene.waitForFrame((text) => text.includes("2026-07-10"))
    expect(frame).toContain("DAILY ACTIVITY")

    const count = harness.queries.length
    harness.setRoute(destination("today", "p", "provider/next"))
    await scene.waitFor(() => harness.queries.length > count)
    const next = harness.queries.at(-1)!
    expect(next.filter).toEqual({ range: "today", projectID: "p", model: "provider/next" })
    next.resolve(dashboard(7, "Beta", "2026-07-11"))
    await scene.mockInput.pressKeys(Array(30).fill("ARROW_UP"), 0)
    frame = await scene.waitForFrame((text) => text.includes("$7.00") && text.includes("Beta"))
    expect(frame).toContain("today")
    expect(frame).toContain("provider/next")
    expect(frame).not.toContain("Alpha")
    expect(frame).not.toContain("$2.00")
    await scene.mockInput.pressKeys(Array(30).fill("ARROW_DOWN"), 0)
    expect(await scene.waitForFrame((text) => text.includes("2026-07-11"))).toContain("DAILY ACTIVITY")
  } finally { await scene.dispose(); await harness.cleanup() }
})

test("wide dashboard restores raised stat cards, filter chips, three cost-bar panels, and a pinned footer", async () => {
  const harness = await createTuiHarness(destination("30d"))
  const scene = await renderDashboard(harness, 40, 144)
  try {
    await scene.waitFor(() => harness.queries.length > 0)
    const data = dashboard(2)
    data.models.push({ id: "free/model", label: "free/model", cost: 0, messages: 2, tokens: 300 })
    data.projects.push({ id: "free-project", label: "free-project", cost: 0, messages: 2, tokens: 300 })
    data.daily.push({ id: "2026-07-11", label: "2026-07-11", cost: 0, messages: 2, tokens: 300 })
    data.total.messages = 3
    harness.queries.at(-1)!.resolve(data)
    const frame = await scene.waitForFrame((text) => text.includes("free/model") && text.includes("2026-07-11"))
    const lines = frame.split("\n")
    const header = lines.find((line) => line.includes("Cost ledger"))!
    expect(header).toContain("all recorded OpenCode sessions")
    expect(header).toContain("esc back")
    expect(header).toContain("d date")
    expect(header).toContain("r refresh")
    const filters = lines.find((line) => line.includes("date: last 30 days"))!
    expect(filters).toContain("project: all projects")
    expect(filters).toContain("model: all models")
    const stats = lines.find((line) => line.includes("TOTAL COST"))!
    for (const label of ["ALL TOKENS", "OUTPUT", "CACHE"]) expect(stats).toContain(label)
    expect(frame).toContain("3 recorded messages")
    expect(frame).toContain("1 input")
    expect(frame).toContain("3 reasoning")
    expect(frame).toContain("4 read")
    const panelHeaders = lines.find((line) => line.includes("BY MODEL"))!
    expect(panelHeaders).toContain("BY PROJECT")
    expect(panelHeaders).toContain("DAILY ACTIVITY")
    expect(lines.filter((line) => line.includes("┌")).length).toBeGreaterThanOrEqual(3)
    const footerIndex = lines.findIndex((line) => line.includes("Provider-reported USD; no pricing is recalculated."))
    expect(footerIndex).toBeGreaterThanOrEqual(37)
    expect(lines[footerIndex]?.trimEnd().endsWith("$2.00")).toBe(true)
    const modelStart = panelHeaders.indexOf("BY MODEL")
    const projectStart = panelHeaders.indexOf("BY PROJECT")
    const dailyStart = panelHeaders.indexOf("DAILY ACTIVITY")
    const zeroModel = lines.findIndex((line) => line.includes("free/model"))
    const zeroProject = lines.findIndex((line) => line.includes("free-project"))
    expect(lines[zeroModel + 1]!.slice(modelStart, projectStart)).toContain("----")
    expect(lines[zeroModel + 1]!.slice(modelStart, projectStart)).not.toContain("#")
    expect(lines[zeroProject + 1]!.slice(projectStart, dailyStart)).toContain("----")
    expect(lines[zeroProject + 1]!.slice(projectStart, dailyStart)).not.toContain("#")
    const freeDay = lines.find((line) => line.includes("2026-07-11"))!.slice(dailyStart)
    expect(freeDay).toContain("----")
    expect(freeDay).not.toContain("#")
    expect(frame).toContain("############")
    const titleSpans = scene.captureSpans().lines.flatMap((line) => line.spans).filter((span) => /TOTAL COST|ALL TOKENS|OUTPUT|CACHE|BY MODEL|BY PROJECT|DAILY ACTIVITY/.test(span.text))
    expect(titleSpans.length).toBeGreaterThanOrEqual(7)
    for (const span of titleSpans) expect(span.bg).toEqual(harness.api.theme.background.raised.base)
    const spans = scene.captureSpans().lines.flatMap((line) => line.spans)
    const accent = harness.api.theme.hue.accent[300]
    const value = harness.api.theme.hue.interactive[300]
    expect(spans.find((span) => span.text.includes("Cost ledger"))?.fg).toEqual(harness.api.theme.text.base)
    expect(spans.find((span) => span.text.includes("TOTAL COST"))?.fg).toEqual(harness.api.theme.text.muted)
    expect(spans.find((span) => span.text.includes("BY MODEL"))?.fg).toEqual(accent)
    expect(spans.filter((span) => span.text.includes("$2.00")).every((span) => span.fg.equals(value))).toBe(true)
    expect(spans.some((span) => span.text.includes("####") && span.fg.equals(accent))).toBe(true)
    expect(spans.some((span) => span.text.includes("----") && span.fg.equals(harness.api.theme.border.base))).toBe(true)
  } finally { await scene.dispose(); await harness.cleanup() }
})

test("header hints are clickable through the same registered commands", async () => {
  const harness = await createTuiHarness(destination("7d"))
  const scene = await renderDashboard(harness, 40, 144)
  try {
    await scene.waitFor(() => harness.queries.length > 0)
    harness.queries.at(-1)!.resolve(dashboard())
    const click = async (text: string) => {
      const lines = (await scene.waitForFrame((frame) => frame.includes(text))).split("\n")
      const y = lines.findIndex((line) => line.includes(text))
      await scene.mockMouse.click(lines[y]!.indexOf(text), y)
      await scene.flush()
    }
    await click("x reset")
    expect(harness.route()).toMatchObject({ type: "plugin", data: { range: "30d" } })
    await click("esc back")
    expect(harness.route()).toEqual({ type: "home" })
  } finally { await scene.dispose(); await harness.cleanup() }
})

test("rendered requests reject stale responses; usage events refresh, and unmount cancels queries/listeners/timers", async () => {
  const harness = await createTuiHarness(destination("30d"))
  const scene = await renderDashboard(harness)
  try {
    await scene.waitFor(() => harness.queries.length > 0)
    const stale = harness.queries.at(-1)!
    const count = harness.queries.length
    harness.setRoute(destination("7d", "p", "provider/model"))
    await scene.waitFor(() => harness.queries.length > count)
    expect(stale.signal.aborted).toBe(true)
    harness.queries.at(-1)!.resolve(dashboard(4, "Fresh"))
    await scene.waitForFrame((text) => text.includes("$4.00") && text.includes("Fresh"))
    stale.resolve(dashboard(99, "Stale")) // Simulate a transport that ignores cancellation.
    await scene.flush()
    let frame = scene.captureCharFrame()
    expect(frame).toContain("$4.00")
    expect(frame).not.toContain("Stale")
    expect(frame).not.toContain("$99.00")

    const beforeEvent = harness.queries.length
    harness.emitUsage()
    expect(harness.queries).toHaveLength(beforeEvent) // Debounced.
    harness.settle()
    await scene.waitFor(() => harness.queries.length > beforeEvent)
    harness.queries.at(-1)!.resolve(dashboard(5, "Updated"))
    await scene.waitForFrame((text) => text.includes("$5.00") && text.includes("Updated"))
    expect(harness.usageListeners.size).toBe(1)
    expect(harness.modes()).toBe(1)

    expect(harness.intervals.size).toBe(1)
    const beforeTick = harness.queries.length
    harness.tick()
    harness.settle()
    await scene.waitFor(() => harness.queries.length > beforeTick)
    const pending = harness.queries.at(-1)!
    harness.emitUsage() // A debounce is also pending when the route leaves.
    harness.setRoute({ type: "home" })
    await scene.flush()
    expect(pending.signal.aborted).toBe(true)
    expect(harness.usageListeners.size).toBe(0)
    expect(harness.modes()).toBe(0)
    expect(harness.intervals.size).toBe(0)
    expect(harness.debounces.size).toBe(0)
    const atUnmount = harness.queries.length
    pending.resolve(dashboard(100, "Unmounted"))
    harness.emitUsage()
    await scene.flush()
    expect(harness.queries).toHaveLength(atUnmount)
    frame = scene.captureCharFrame()
    expect(frame).not.toContain("Cost ledger")
    expect(frame).not.toContain("Unmounted")
  } finally { await scene.dispose(); await harness.cleanup() }
})

test("shared screen mount releases keyboard scope and cancels a pending selector when the view alone unmounts", async () => {
  const harness = await createTuiHarness(destination("30d"))
  const scene = await renderDashboard(harness)
  let disposed = false
  try {
    await scene.waitFor(() => harness.queries.length > 0)
    harness.queries.at(-1)!.resolve(dashboard())
    await scene.waitForFrame((frame) => frame.includes("TOTAL COST"))
    expect(harness.modes()).toBe(1)
    const selection = harness.run("project")
    const pending = harness.queries.at(-1)!
    await scene.dispose()
    disposed = true
    expect(isDashboardRoute(harness.route())).toBe(true)
    expect(harness.modes()).toBe(0)
    expect(harness.usageListeners.size).toBe(0)
    expect(pending.signal.aborted).toBe(true)
    pending.resolve(dashboard())
    await selection
    expect(harness.dialogs).toHaveLength(0)
    expect(harness.toasts).toHaveLength(0)
  } finally {
    if (!disposed) await scene.dispose()
    await harness.cleanup()
  }
})

test("same-query streaming refreshes keep cards and scroll mounted, coalesce requests, and recover quietly from failure", async () => {
  const harness = await createTuiHarness(destination("30d"))
  const scene = await renderDashboard(harness, 24)
  try {
    await scene.waitFor(() => harness.queries.length > 0)
    harness.queries.at(-1)!.resolve(dashboard(2))
    await scene.waitForFrame((frame) => frame.includes("TOTAL COST") && frame.includes("$2.00"))
    const totals = scene.renderer.root.findDescendantById("opcode-cost.totals")
    expect(totals).toBeDefined()
    const scroll = scene.renderer.root.findDescendantById("opcode-cost.content")
    if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing cost scroll viewport")
    await scene.mockInput.pressKeys(Array(30).fill("ARROW_DOWN"), 0)
    await scene.flush()
    const position = scroll.scrollTop
    expect(position).toBeGreaterThan(0)
    const beforeRefresh = harness.queries.length

    harness.emitUsage()
    harness.settle()
    await scene.waitFor(() => harness.queries.length === beforeRefresh + 1)
    const request = harness.queries.at(-1)!
    await scene.flush()
    expect(scene.renderer.root.findDescendantById("opcode-cost.totals")).toBe(totals)
    expect(scene.captureCharFrame()).toContain("$2.00")
    expect(scene.captureCharFrame()).not.toContain("Loading server ledger")
    expect(scroll.scrollTop).toBe(position)

    for (let index = 0; index < 20; index++) { harness.tick(); harness.emitUsage() }
    // Even a new route object with identical filter values is the same query.
    harness.setRoute(destination("30d"))
    harness.settle()
    await scene.flush()
    expect(harness.queries).toHaveLength(beforeRefresh + 1)
    expect(request.signal.aborted).toBe(false)
    expect(scene.renderer.root.findDescendantById("opcode-cost.totals")).toBe(totals)
    expect(scroll.scrollTop).toBe(position)

    request.resolve(dashboard(3))
    await scene.waitForFrame((frame) => frame.includes("$3.00"))
    harness.settle() // The follow-up is debounced too.
    await scene.waitFor(() => harness.queries.length === beforeRefresh + 2)
    const followUp = harness.queries.at(-1)!
    expect(followUp.signal.aborted).toBe(false)
    expect(scroll.scrollTop).toBe(position)
    expect(scene.renderer.root.findDescendantById("opcode-cost.totals")).toBe(totals)

    followUp.reject(new Error("offline"))
    let frame = await scene.waitForFrame((text) => text.includes("Refresh failed: offline"))
    expect(frame).toContain("$3.00")
    expect(frame).not.toContain("Unable to read ledger")
    expect(frame).not.toContain("Loading server ledger")
    expect(scroll.scrollTop).toBe(position)
    expect(scene.renderer.root.findDescendantById("opcode-cost.totals")).toBe(totals)

    harness.tick()
    harness.settle()
    await scene.waitFor(() => harness.queries.length === beforeRefresh + 3)
    await scene.flush()
    expect(scene.captureCharFrame()).toContain("Refresh failed: offline")
    harness.queries.at(-1)!.resolve(dashboard(4))
    frame = await scene.waitForFrame((text) => text.includes("$4.00") && !text.includes("Refresh failed"))
    expect(frame).not.toContain("Loading server ledger")
    expect(scroll.scrollTop).toBe(position)
    expect(scene.renderer.root.findDescendantById("opcode-cost.totals")).toBe(totals)
    expect(harness.queries).toHaveLength(beforeRefresh + 3)
  } finally { await scene.dispose(); await harness.cleanup() }
})

test("changed filters clear loaded values, reject late old-query results, and show an honest new-query failure", async () => {
  const harness = await createTuiHarness(destination("30d", "p", "provider/model"), true)
  const scene = await renderDashboard(harness)
  try {
    await scene.waitFor(() => harness.queries.length > 0)
    harness.queries.at(-1)!.resolve(dashboard(2, "Alpha"))
    await scene.waitForFrame((frame) => frame.includes("Alpha") && frame.includes("TOTAL COST"))
    const originalTotals = scene.renderer.root.findDescendantById("opcode-cost.totals")
    const beforeRefresh = harness.queries.length
    harness.emitUsage()
    harness.settle()
    await scene.waitFor(() => harness.queries.length === beforeRefresh + 1)
    const oldQuery = harness.queries.at(-1)!

    harness.setRoute(destination("today", "p", "provider/model"))
    await scene.waitFor(() => harness.queries.length === beforeRefresh + 2)
    const next = harness.queries.at(-1)!
    expect(oldQuery.signal.aborted).toBe(true)
    let frame = await scene.waitForFrame((text) => text.includes("Loading server ledger"))
    expect(frame).toContain("today")
    expect(frame).not.toContain("Alpha")
    expect(frame).not.toContain("$2.00")
    expect(scene.renderer.root.findDescendantById("opcode-cost.totals")).toBeUndefined()

    next.reject(new Error("filtered query failed"))
    frame = await scene.waitForFrame((text) => text.includes("Unable to read ledger") && text.includes("filtered query failed"))
    expect(frame).not.toContain("Refresh failed")
    expect(frame).not.toContain("TOTAL COST")
    oldQuery.resolve(dashboard(99, "Stale"))
    await scene.flush()
    frame = scene.captureCharFrame()
    expect(frame).not.toContain("Stale")
    expect(frame).not.toContain("$99.00")
    expect(frame).toContain("Unable to read ledger")

    harness.emitUsage()
    harness.settle()
    await scene.waitFor(() => harness.queries.length === beforeRefresh + 3)
    harness.queries.at(-1)!.resolve(dashboard(7, "Beta"))
    frame = await scene.waitForFrame((text) => text.includes("Beta") && text.includes("$7.00"))
    expect(frame).not.toContain("Unable to read ledger")
    expect(frame).not.toContain("Stale")
    expect(scene.renderer.root.findDescendantById("opcode-cost.totals")).not.toBe(originalTotals)
  } finally { await scene.dispose(); await harness.cleanup() }
})

test("changing server location clears same-filter data and cannot accept the previous location's pending response", async () => {
  const harness = await createTuiHarness(destination("30d", "p", "provider/model"))
  const scene = await renderDashboard(harness)
  try {
    await scene.waitFor(() => harness.queries.length > 0)
    harness.queries.at(-1)!.resolve(dashboard(2, "Alpha"))
    await scene.waitForFrame((frame) => frame.includes("Alpha") && frame.includes("TOTAL COST"))
    const beforeRefresh = harness.queries.length
    harness.emitUsage()
    harness.settle()
    await scene.waitFor(() => harness.queries.length === beforeRefresh + 1)
    const oldQuery = harness.queries.at(-1)!
    harness.setLocation({ directory: "/another/location" })
    await scene.waitFor(() => harness.queries.length === beforeRefresh + 2)
    const next = harness.queries.at(-1)!
    expect(oldQuery.signal.aborted).toBe(true)
    let frame = await scene.waitForFrame((text) => text.includes("Loading server ledger"))
    expect(frame).not.toContain("Alpha")
    expect(frame).not.toContain("$2.00")
    oldQuery.resolve(dashboard(99, "Stale"))
    await scene.flush()
    expect(scene.captureCharFrame()).not.toContain("Stale")
    next.resolve(dashboard(6, "Beta"))
    frame = await scene.waitForFrame((text) => text.includes("Beta") && text.includes("$6.00"))
    expect(frame).not.toContain("Loading server ledger")
    expect(frame).not.toContain("$99.00")
  } finally { await scene.dispose(); await harness.cleanup() }
})

test("an initial query failure has no stale cards or background-success implication", async () => {
  const harness = await createTuiHarness(destination("30d"))
  const scene = await renderDashboard(harness)
  try {
    await scene.waitFor(() => harness.queries.length > 0)
    harness.queries.at(-1)!.reject(new Error("server unavailable"))
    const frame = await scene.waitForFrame((text) => text.includes("Unable to read ledger") && text.includes("server unavailable"))
    expect(frame).not.toContain("Refresh failed")
    expect(frame).not.toContain("showing last loaded usage")
    expect(frame).not.toContain("TOTAL COST")
    expect(scene.renderer.root.findDescendantById("opcode-cost.totals")).toBeUndefined()
  } finally { await scene.dispose(); await harness.cleanup() }
})

test("Time tab shows turn timing and opens a longest turn's session; tab switches back to cost", async () => {
  const harness = await createTuiHarness({ ...destination("7d"), data: { range: "7d", tab: "time" } })
  const scene = await renderDashboard(harness, 48, 144)
  const row = (id: string, label: string, agent: number) => ({ id, label, agent, wait: 300_000, turns: 2 })
  try {
    await scene.waitFor(() => harness.times.length > 0)
    expect(harness.queries).toHaveLength(0)
    expect(harness.times.at(-1)!.filter).toEqual({ range: "7d", projectID: undefined, model: undefined })
    harness.times.at(-1)!.resolve({
      total: { agent: 5_400_000, turns: 3, wait: 900_000, parallel: 120_000, peak: 2 },
      models: [row("provider/model (high)", "provider/model (high)", 5_400_000)],
      projects: [row("p", "Alpha", 5_400_000)],
      daily: [row("2026-07-10", "2026-07-10", 5_400_000)],
      longest: [
        { sessionID: "elsewhere", title: "Remote refactor", project: "Beta", directory: "/other", model: "provider/model", start: 0, duration: 3_600_000 },
        { sessionID: "here", title: "Fix login", project: "Alpha", directory: "/remote/project", model: "provider/model (high)", start: 0, duration: 1_800_000 },
      ],
    })
    const frame = await scene.waitForFrame((text) => text.includes("LONGEST TURNS"))
    for (const text of ["AGENT TIME", "1h 30m", "3 turns", "WAITING ON YOU", "15m 00s", "PARALLEL", "2m 00s", "peak 2 sessions",
      "BY MODEL", "BY PROJECT", "DAILY ACTIVITY", "5m 00s wait", "> Remote refactor", "Fix login", "Beta  provider/model"]) {
      expect(frame).toContain(text)
    }
    expect(frame.split("\n").find((line) => line.includes("Root sessions only"))?.trimEnd().endsWith("1h 30m")).toBe(true)

    await harness.run("turn.next")
    await scene.waitForFrame((text) => text.includes("> Fix login"))
    await harness.run("turn.open")
    expect(harness.route()).toEqual({ type: "session", sessionID: "here" })

    harness.setRoute({ ...destination("7d"), data: { range: "7d", tab: "time" } })
    await scene.waitFor(() => harness.times.length > 1)
    await harness.run("tab")
    expect(harness.route()).toMatchObject({ data: { range: "7d", tab: "cost" } })
    await scene.waitFor(() => harness.queries.length > 0)
  } finally { await scene.dispose(); await harness.cleanup() }
})
