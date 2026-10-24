import { expect, test } from "bun:test"
import type { TimeDashboard } from "../src/domain.js"
import { createTuiHarness, dashboard, timeDashboard } from "./tui-harness.js"

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
    harness.respond()
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
    expect(harness.queries.at(-1)!.filter).toEqual({ range: "30d" })
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
    harness.respond(priced)
    await harness.frame((text) => text.includes("TOTAL COST"))
    harness.run("next") // Models
    let frame = await harness.frame((text) => text.includes("free/model"))
    for (const text of ["$2.00  15 tok", "$0.00  300 tok"]) expect(frame).toContain(text)
    // Bars follow cost, so the free model's stays empty.
    expect(barUnder(frame, "free/model")).not.toContain("#")

    const free = dashboard(0)
    free.models.push({ id: "free/model", label: "free/model", cost: 0, messages: 2, tokens: 300 })
    const count = harness.queries.length
    harness.setLocation({ directory: "/subscription" })
    await harness.scene.waitFor(() => harness.queries.length > count)
    harness.respond(free)
    frame = await harness.frame((text) => text.includes("300 tok") && !text.includes("$"))
    expect(barUnder(frame, "free/model")).toContain("#")
    harness.run("previous")
    frame = await harness.frame((text) => text.includes("ALL TOKENS"))
    expect(frame).not.toContain("TOTAL COST")
  } finally { await harness.cleanup() }
})

test("the date range applies to every tab and shows before the search box", async () => {
  const harness = await createTuiHarness()
  try {
    harness.open()
    harness.respond()
    await harness.frame((text) => text.includes("last 30 days ›"))
    harness.run("date")
    // The picker opens on the current range, the last one.
    await harness.frame((text) => text.includes("> Last 30 days") && text.includes("All time"))
    harness.run("up")
    harness.run("activate")
    await harness.scene.waitFor(() => harness.queries.at(-1)!.filter.range === "7d" && harness.times.at(-1)!.filter.range === "7d")
    harness.respond()
    await harness.frame((text) => text.includes("last 7 days ›"))
    harness.run("next")
    await harness.frame((text) => text.includes("last 7 days ›") && text.includes("provider/model"))
  } finally { await harness.cleanup() }
})

test("time joins the breakdowns; ↑/↓ select turns one at a time, and enter opens a searched-for turn's session", async () => {
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
    harness.respond(dashboard(), time)
    let frame = await harness.frame((text) => text.includes("AGENT TIME"))
    for (const text of ["1h 30m", "15m 00s"]) expect(frame).toContain(text)
    harness.run("next")
    harness.run("next") // Projects
    await harness.frame((text) => text.includes("1 msg") && text.includes("1h 30m agent"))

    harness.run("next")
    harness.run("next") // Turns
    await harness.frame((text) => text.includes("> Remote refactor") && text.includes("  Fix login"))
    harness.run("down")
    await harness.frame((text) => text.includes("> Fix login") && text.includes("  Remote refactor"))
    harness.run("search")
    await harness.scene.mockInput.typeText("remote")
    await harness.frame((text) => text.includes("> Remote refactor") && !text.includes("Fix login"))
    harness.scene.mockInput.pressEnter() // The box submits.
    await harness.scene.waitFor(() => !harness.isOpen())
    expect(harness.navigations).toEqual([{ type: "session", sessionID: "elsewhere" }])
  } finally { await harness.cleanup() }
})

test("background refreshes keep cards mounted, coalesce, and keep the last usage with a warning when one fails", async () => {
  const harness = await createTuiHarness()
  try {
    harness.open()
    harness.respond(dashboard(2))
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
    harness.respond(dashboard(4))
    await harness.frame((text) => text.includes("$4.00") && !text.includes("Refresh failed"))
    expect(harness.scene.renderer.root.findDescendantById("opcode-cost.totals")).toBe(totals)
  } finally { await harness.cleanup() }
})

test("a new range or location drops loaded usage, ignores the old read's late result, and fails honestly", async () => {
  const harness = await createTuiHarness()
  try {
    harness.open()
    harness.run("next")
    harness.run("next") // Projects
    harness.respond(dashboard(2, "Alpha"))
    await harness.frame((text) => text.includes("Alpha"))
    harness.emitUsage()
    harness.settle()
    const old = { usage: harness.queries.at(-1)!, time: harness.times.at(-1)! }

    harness.setLocation({ directory: "/another/location" })
    expect(old.usage.signal.aborted).toBe(true)
    let frame = await harness.frame((text) => text.includes("Loading server ledger"))
    expect(frame).not.toContain("Alpha")
    old.usage.resolve(dashboard(99, "Stale"))
    old.time.resolve(timeDashboard())
    harness.queries.at(-1)!.reject(new Error("server unavailable"))
    frame = await harness.frame((text) => text.includes("Unable to read ledger") && text.includes("server unavailable"))
    expect(frame).not.toContain("Stale")
    expect(frame).not.toContain("Refresh failed")

    harness.run("date")
    for (let step = 0; step < 3; step++) harness.run("up")
    harness.run("activate")
    await harness.scene.waitFor(() => harness.queries.at(-1)!.filter.range === "all")
    harness.respond(dashboard(7, "Beta"))
    frame = await harness.frame((text) => text.includes("Beta"))
    expect(frame).not.toContain("Unable to read ledger")
  } finally { await harness.cleanup() }
})

test("import failures belong to their location; switching cancels the old import, and r retries the current one", async () => {
  const harness = await createTuiHarness()
  const failure = "History import failed: offline. Press r to retry."
  try {
    harness.open()
    harness.respond()
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
    harness.respond()
    const before = harness.queries.length
    // The settled import rereads the open view, so imported history appears.
    history.resolve({ data: [], cursor: {} })
    await harness.frame((text) => !text.includes("History import failed"))
    harness.settle()
    expect(harness.queries).toHaveLength(before + 1)
  } finally { await harness.cleanup() }
})
