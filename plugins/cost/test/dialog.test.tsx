import { expect, test } from "bun:test"
import type { TimeDashboard } from "../src/domain.js"
import { createTuiHarness, dashboard } from "./tui-harness.js"

test("/cost opens a large centered dialog; esc closes it and stops its reads, and reopening starts over", async () => {
  const harness = await createTuiHarness()
  try {
    harness.open()
    expect(harness.dialogOptions()).toEqual({ size: "large", centered: true })
    await harness.frame((text) => text.includes("Loading server ledger"))
    harness.run("date")
    for (let step = 0; step < 3; step++) harness.run("up")
    harness.run("activate") // "All time"
    await harness.scene.waitFor(() => harness.queries.at(-1)!.filter.range === "all")
    harness.queries.at(-1)!.resolve(dashboard())
    await harness.frame((text) => text.includes("TOTAL COST"))
    harness.emitUsage()
    harness.settle()
    const pending = harness.queries.at(-1)!

    harness.run("close")
    await harness.scene.flush()
    expect(harness.isOpen()).toBe(false)
    expect(pending.signal.aborted).toBe(true)
    expect(harness.usageListeners.size).toBe(0)
    expect(harness.intervals.size).toBe(0)
    expect(harness.debounces.size).toBe(0)

    harness.open()
    await harness.scene.waitFor(() => harness.queries.at(-1) !== pending)
    expect(harness.queries.at(-1)!.filter).toEqual({ range: "30d", projectID: undefined, model: undefined })
  } finally { await harness.cleanup() }
})

test("unloading clears an open dialog and cancels the history import", async () => {
  const harness = await createTuiHarness()
  try {
    harness.open()
    let signal!: AbortSignal
    harness.api.client.session.list = ((_input: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
    }) as never
    harness.run("refresh")
    await harness.scene.waitFor(() => signal !== undefined)
    await harness.unload()
    expect(harness.isOpen()).toBe(false)
    expect(signal.aborted).toBe(true)
  } finally { await harness.cleanup() }
})

test("a priced view shows cost with tokens; a $0 view hides cost and sizes everything by tokens", async () => {
  const harness = await createTuiHarness({ width: 80 })
  const barUnder = (frame: string, label: string) => {
    const lines = frame.split("\n")
    return lines[lines.findIndex((line) => line.includes(label)) + 1]!
  }
  try {
    harness.open()
    const priced = dashboard(2)
    priced.models.push({ id: "free/model", label: "free/model", cost: 0, messages: 2, tokens: 300 })
    harness.queries.at(-1)!.resolve(priced)
    let frame = await harness.frame((text) => text.includes("free/model"))
    for (const text of ["TOTAL COST", "ALL TOKENS", "$2.00  15 tok", "$0.00  300 tok"]) expect(frame).toContain(text)
    // Bars follow cost, so the free model's stays empty.
    expect(barUnder(frame, "free/model")).not.toContain("#")

    const free = dashboard(0)
    free.models.push({ id: "free/model", label: "free/model", cost: 0, messages: 2, tokens: 300 })
    const count = harness.queries.length
    harness.setLocation({ directory: "/subscription" })
    await harness.scene.waitFor(() => harness.queries.length > count)
    harness.queries.at(-1)!.resolve(free)
    frame = await harness.frame((text) => text.includes("300 tok") && !text.includes("TOTAL COST"))
    expect(frame).not.toContain("$")
    expect(barUnder(frame, "free/model")).toContain("#")
  } finally { await harness.cleanup() }
})

test("pickers set filters that both tabs share, shown before the search box; x resets them", async () => {
  const harness = await createTuiHarness()
  try {
    harness.open()
    harness.queries.at(-1)!.resolve(dashboard())
    await harness.frame((text) => text.includes("BY PROJECT"))

    harness.run("date")
    // The picker opens on the current range, the last one.
    await harness.frame((text) => text.includes("> Last 30 days") && text.includes("All time"))
    harness.run("up")
    harness.run("activate")
    await harness.scene.waitFor(() => harness.queries.at(-1)!.filter.range === "7d")
    harness.queries.at(-1)!.resolve(dashboard())
    await harness.frame((text) => text.includes("last 7 days ›"))

    harness.run("project")
    const options = harness.queries.at(-1)!
    expect(options.filter).toEqual({ range: "7d", projectID: undefined, model: undefined })
    const data = dashboard()
    data.projectOptions = [
      { id: "opaque-project-a", label: "main", directory: "/remote/a/main" },
      { id: "opaque-project-b", label: "main", directory: "/remote/b/main" },
    ]
    options.resolve(data)
    await harness.frame((text) => text.includes("/remote/a/main") && text.includes("/remote/b/main"))
    harness.run("down")
    harness.run("down")
    harness.run("activate")
    await harness.scene.waitFor(() => harness.queries.at(-1)!.filter.projectID === "opaque-project-b")
    harness.queries.at(-1)!.resolve(dashboard())
    const frame = await harness.frame((text) => text.includes("last 7 days · main ›"))
    expect(frame).not.toContain("BY PROJECT")

    harness.run("next")
    await harness.scene.waitFor(() => harness.times.length > 0)
    expect(harness.times.at(-1)!.filter).toEqual({ range: "7d", projectID: "opaque-project-b", model: undefined })
    harness.run("model")
    harness.queries.at(-1)!.resolve(dashboard())
    await harness.frame((text) => text.includes("All models"))
    harness.run("down")
    harness.run("activate")
    await harness.scene.waitFor(() => harness.times.at(-1)!.filter.model === "provider/model")

    harness.run("reset")
    await harness.scene.waitFor(() => harness.times.at(-1)!.filter.range === "30d")
    expect(harness.times.at(-1)!.filter).toEqual({ range: "30d", projectID: undefined, model: undefined })
  } finally { await harness.cleanup() }
})

test("esc while project options load goes back to the tab, aborting the request, and never closes the dialog", async () => {
  const harness = await createTuiHarness()
  try {
    harness.open()
    harness.queries.at(-1)!.resolve(dashboard())
    await harness.frame((text) => text.includes("TOTAL COST"))
    harness.run("project")
    await harness.frame((text) => text.includes("Loading projects"))
    const options = harness.queries.at(-1)!
    harness.run("close")
    await harness.frame((text) => text.includes("TOTAL COST"))
    expect(options.signal.aborted).toBe(true)
    expect(harness.isOpen()).toBe(true)
    options.resolve(dashboard())
    await harness.scene.flush()
    expect(harness.scene.captureCharFrame()).not.toContain("All projects")
  } finally { await harness.cleanup() }
})

test("the search box narrows the breakdowns", async () => {
  const harness = await createTuiHarness()
  try {
    harness.open()
    const data = dashboard()
    data.models.push({ id: "other/model", label: "other/model", cost: 1, messages: 1, tokens: 5 })
    harness.queries.at(-1)!.resolve(data)
    await harness.frame((text) => text.includes("other/model"))
    harness.run("search")
    await harness.scene.mockInput.typeText("other")
    const frame = await harness.frame((text) => !text.includes("provider/model"))
    expect(frame).toContain("other/model")
  } finally { await harness.cleanup() }
})

test("the Time tab shows turn timing, and opening a searched-for turn closes the dialog for its session", async () => {
  const harness = await createTuiHarness({ width: 144, height: 48 })
  const row = (id: string, label: string, agent: number) => ({ id, label, agent, wait: 300_000, turns: 2 })
  const time: TimeDashboard = {
    total: { agent: 5_400_000, turns: 3, wait: 900_000, parallel: 120_000, peak: 2 },
    models: [row("provider/model (high)", "provider/model (high)", 5_400_000)],
    projects: [row("p", "Alpha", 5_400_000)],
    daily: [row("2026-07-10", "2026-07-10", 5_400_000)],
    longest: [
      { sessionID: "elsewhere", title: "Remote refactor", project: "Beta", directory: "/other", model: "provider/model", start: 0, duration: 3_600_000 },
      { sessionID: "here", title: "Fix login", project: "Alpha", directory: "/remote/project", model: "provider/model (high)", start: 0, duration: 1_800_000 },
    ],
  }
  try {
    harness.open()
    harness.run("next")
    await harness.scene.waitFor(() => harness.times.length > 0)
    harness.times.at(-1)!.resolve(time)
    const frame = await harness.frame((text) => text.includes("> Remote refactor"))
    for (const text of ["1h 30m", "15m 00s", "Fix login"]) expect(frame).toContain(text)
    // Enter opens the selected turn among those the search left.
    harness.run("search")
    await harness.scene.mockInput.typeText("login")
    await harness.frame((text) => text.includes("> Fix login") && !text.includes("Remote refactor"))
    harness.scene.mockInput.pressEnter() // The box submits.
    await harness.scene.waitFor(() => !harness.isOpen())
    expect(harness.navigations).toEqual([{ type: "session", sessionID: "here" }])
  } finally { await harness.cleanup() }
})

test("background refreshes keep cards mounted, coalesce, and keep the last usage with a warning when one fails", async () => {
  const harness = await createTuiHarness()
  try {
    harness.open()
    harness.queries.at(-1)!.resolve(dashboard(2))
    await harness.frame((text) => text.includes("$2.00"))
    const totals = harness.scene.renderer.root.findDescendantById("opcode-cost.totals")
    expect(totals).toBeDefined()
    const before = harness.queries.length
    for (let index = 0; index < 20; index++) { harness.tick(); harness.emitUsage() }
    expect(harness.queries).toHaveLength(before) // Debounced.
    harness.settle()
    expect(harness.queries).toHaveLength(before + 1)
    harness.queries.at(-1)!.reject(new Error("offline"))
    const frame = await harness.frame((text) => text.includes("Refresh failed: offline"))
    expect(frame).toContain("$2.00")
    expect(harness.scene.renderer.root.findDescendantById("opcode-cost.totals")).toBe(totals)

    harness.tick()
    harness.settle()
    harness.queries.at(-1)!.resolve(dashboard(4))
    await harness.frame((text) => text.includes("$4.00") && !text.includes("Refresh failed"))
    expect(harness.scene.renderer.root.findDescendantById("opcode-cost.totals")).toBe(totals)
  } finally { await harness.cleanup() }
})

test("a new filter or location drops loaded usage, ignores the old query's late result, and fails honestly", async () => {
  const harness = await createTuiHarness()
  try {
    harness.open()
    harness.queries.at(-1)!.resolve(dashboard(2, "Alpha"))
    await harness.frame((text) => text.includes("Alpha"))
    harness.emitUsage()
    harness.settle()
    const old = harness.queries.at(-1)!

    harness.setLocation({ directory: "/another/location" })
    expect(old.signal.aborted).toBe(true)
    let frame = await harness.frame((text) => text.includes("Loading server ledger"))
    expect(frame).not.toContain("Alpha")
    old.resolve(dashboard(99, "Stale"))
    const next = harness.queries.at(-1)!
    next.reject(new Error("server unavailable"))
    frame = await harness.frame((text) => text.includes("Unable to read ledger") && text.includes("server unavailable"))
    expect(frame).not.toContain("Stale")
    expect(frame).not.toContain("Refresh failed")

    harness.run("date")
    for (let step = 0; step < 3; step++) harness.run("up")
    harness.run("activate")
    await harness.scene.waitFor(() => harness.queries.at(-1)!.filter.range === "all")
    harness.queries.at(-1)!.resolve(dashboard(7, "Beta"))
    frame = await harness.frame((text) => text.includes("Beta"))
    expect(frame).not.toContain("Unable to read ledger")
  } finally { await harness.cleanup() }
})

test("import failures belong to their location; switching cancels the old import, and r retries the current one", async () => {
  const harness = await createTuiHarness()
  const failure = "History import failed: offline. Press r to retry."
  try {
    harness.open()
    harness.queries.at(-1)!.resolve(dashboard())
    await harness.frame((text) => text.includes("TOTAL COST"))
    // A transport that ignores cancellation, failing only after the location changed.
    const late = Promise.withResolvers<never>()
    const listed = Promise.withResolvers<AbortSignal>()
    harness.api.client.session.list = ((_input: unknown, options: { signal: AbortSignal }) => {
      listed.resolve(options.signal)
      return late.promise
    }) as never
    harness.run("refresh")
    await harness.frame((text) => text.includes("refreshing"))
    const first = await listed.promise
    harness.api.client.session.list = async () => ({ data: [], cursor: {} })
    harness.setLocation({ directory: "/another/location" })
    expect(first.aborted).toBe(true)
    late.reject(new Error("offline"))
    await harness.scene.flush()
    expect(harness.scene.captureCharFrame()).not.toContain("History import failed")

    harness.api.client.session.list = async () => { throw new Error("offline") }
    harness.setLocation({ directory: "/remote/project" })
    await harness.frame((text) => text.includes(failure))
    const history = Promise.withResolvers<{ data: never[]; cursor: {} }>()
    harness.api.client.session.list = () => history.promise
    harness.run("refresh")
    harness.settle()
    harness.queries.at(-1)!.resolve(dashboard())
    const before = harness.queries.length
    // The settled import rereads the open view, so imported history appears.
    history.resolve({ data: [], cursor: {} })
    await harness.frame((text) => !text.includes("History import failed"))
    harness.settle()
    expect(harness.queries).toHaveLength(before + 1)
  } finally { await harness.cleanup() }
})
