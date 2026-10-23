import "@opentui/solid/preload"
import { afterEach, expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, Destination, KeymapLayer, Page, Route, SlotClaim } from "@opencode/plugin/tui/context"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { join } from "node:path"
import { createComponent } from "solid-js"
import { mockTheme, tempDir } from "@opcode/ui/test-support/host"
import { LaterDatabase } from "../src/sqlite"

// Load JSX after installing the OpenTUI Solid transform. This file itself has no JSX.
const { default: plugin } = await import("../src/tui")
const cleanup: Array<() => void> = []
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop() })
const lastIndex = (lines: string[], match: (line: string) => unknown) => lines.length - 1 - [...lines].reverse().findIndex(match)

function harness() {
  const directory = tempDir("opcode-later-tui-")
  cleanup.push(directory.remove)
  const path = join(directory.path, "later.sqlite")
  const external = new LaterDatabase(path)
  cleanup.push(() => external.close())
  let route: Route = { type: "home" }
  let prompt: string | undefined
  let mode = "base"
  const layers: Array<() => KeymapLayer> = []
  const routes: Page[] = []
  const slots: SlotClaim[] = []
  const api = {
    options: { database: path },
    renderer: { isDestroyed: false, once: () => {}, off: () => {}, requestRender: () => {} },
    theme: mockTheme(),
    ui: {
      router: {
        current: () => route,
        navigate: (next: Destination) => { route = next.type === "plugin" ? { id: "opcode-later", ...next } : next },
        register: (page: Page) => { routes.push(page); return () => { routes.splice(routes.indexOf(page), 1) } },
      },
      slot: (slot: SlotClaim) => { slots.push(slot); return () => { slots.splice(slots.indexOf(slot), 1) } },
      toast: { show: () => {} },
      dialog: { prompt: async () => prompt, confirm: async () => true },
    },
    keymap: {
      layer: (factory: () => KeymapLayer) => { layers.push(factory) },
      dispatch: (id: string) => {
        const command = layers.flatMap((factory) => factory().commands ?? []).find((entry) => entry.id === id)
        if (command) void command.run()
      },
      mode: {
        push: (next: string) => { const before = mode; mode = next; return () => { mode = before } },
      },
      commands: () => [{ id: "prompt.paste" }],
    },
  }
  const context = api as unknown as Context
  const stop = plugin.setup(context) as () => void
  cleanup.push(stop)
  return {
    api, context, external, layers, routes, slots, stop,
    mode: () => mode,
    route: () => route,
    prompt: (value: string) => { prompt = value },
    async run(action: string) {
      const command = layers.flatMap((factory) => factory().commands ?? []).find((entry) => entry.id === `opcode-later.${action}`)
      if (!command) throw new Error(`Missing Later command: ${action}`)
      await command.run()
    },
  }
}

test("V2 TUI setup registers /later, sidebar contribution, keyboard workflow, and removes UI on cleanup", async () => {
  const h = harness()
  expect(plugin.id).toBe("opcode-later")
  const global = h.layers.map((layer) => layer()).find((layer) => layer.mode === "global")
  expect(global?.commands?.find((command) => command.id === "opcode-later.open")).toMatchObject({
    palette: true, slash: { name: "later" },
  })
  const manager = h.layers.map((layer) => layer()).find((layer) => layer.mode === "opcode-later.manage")
  const bindings = {
    close: ["escape"], add: ["a"], edit: ["e"], complete: ["space"], paste: ["return"], delete: ["d"],
    up: ["up", "k"], down: ["down", "j"], moveUp: ["shift+k"], moveDown: ["shift+j"], history: ["h"], refresh: ["r"],
  }
  for (const [action, expected] of Object.entries(bindings)) {
    const bind = manager?.commands?.find((command) => command.id === `opcode-later.${action}`)?.bind
    expect(typeof bind === "string" ? bind.split(",").sort() : bind).toEqual([...expected].sort())
  }
  expect(h.slots[0]?.after).toBe("sidebar.content")
  await h.run("open")
  h.stop()
  h.stop()
  expect(h.route()).toEqual({ type: "home" })
  expect(h.routes).toEqual([])
  expect(h.slots).toEqual([])
})

test("sidebar reacts to empty, active, and completed states", async () => {
  const h = harness()
  const slot = h.slots[0] as SlotClaim<"sidebar.content">
  const view = await testRender(() => createComponent(PluginContextProvider, {
    value: h.context,
    get children() { return slot.render({ sessionID: "any-session" }) },
  }), { width: 42, height: 12 })
  try {
    await view.flush()
    expect(view.captureCharFrame()).not.toContain("Later")
    await h.run("open")
    h.prompt("visible item")
    await h.run("add")
    await view.flush()
    expect(view.captureCharFrame()).toContain("Later")
    expect(view.captureCharFrame()).toContain("1.  visible item")
    await h.run("complete")
    await view.flush()
    expect(view.captureCharFrame()).not.toContain("Later")
  } finally { await view.dispose() }
})

test("setup's automatic timer renders cross-client changes and repairs the selected row", async () => {
  const h = harness()
  const first = h.external.add("deleted selection", 1)
  const second = h.external.add("remaining item", 2)
  await h.run("open")
  const view = await testRender(() => createComponent(PluginContextProvider, {
    value: h.context,
    get children() { return h.routes[0]!.render({}) },
  }), { width: 80, height: 24 })
  try {
    await view.flush()
    expect(view.captureCharFrame()).toContain("> 1. deleted selection")
    h.external.delete(h.external.get(first)!)
    h.external.edit(h.external.get(second)!, "updated by another client", 3)
    // No commands or manual poll/refresh: removing setup's interval must break this.
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      await view.flush()
      if (view.captureCharFrame().includes("> 1. updated by another client")) break
      await Bun.sleep(25)
    }
    expect(view.captureCharFrame()).not.toContain("deleted selection")
    expect(view.captureCharFrame()).toContain("> 1. updated by another client")
  } finally { await view.dispose() }
})

test("manager renders history, uses scoped input mode, and follows keyboard selection", async () => {
  const h = harness()
  for (let index = 1; index <= 20; index++) h.external.add(`active item ${String(index).padStart(2, "0")}`, index)
  const completed = h.external.add("completed history", 21)
  h.external.complete(h.external.get(completed)!, 22)
  await h.run("open")
  const view = await testRender(() => createComponent(PluginContextProvider, {
    value: h.context,
    get children() { return h.routes[0]!.render({}) },
  }), { width: 100, height: 26 })
  Object.assign(h.api, { renderer: view.renderer })
  try {
    await view.flush()
    expect(h.mode()).toBe("opcode-later.manage")
    expect(view.captureCharFrame()).toContain("active item 01")
    expect(view.captureCharFrame()).not.toContain("completed history")
    for (let index = 1; index < 20; index++) await h.run("down")
    await view.waitForFrame((frame) => frame.includes("active item 20"))
    expect(view.captureCharFrame()).toContain("> 20. active item 20")
    await h.run("history")
    await h.run("down")
    await view.waitForFrame((frame) => frame.includes("completed history"))
    expect(view.captureCharFrame()).toContain("COMPLETED HISTORY")
  } finally { await view.dispose() }
  expect(h.mode()).toBe("base")
})

test("real OpenTUI paste completes while requestLive stays active, preserves text, and never submits", async () => {
  const h = harness()
  const view = await createTestRenderer({ width: 60, height: 12 })
  let submissions = 0
  const input = new TextareaRenderable(view.renderer, { id: "test-prompt", width: 60, height: 6, onSubmit: () => { submissions++ } })
  view.renderer.root.add(input)
  input.focus()
  input.insertText("existing: ")
  Object.assign(h.api, { renderer: view.renderer })
  view.renderer.requestLive()
  try {
    h.external.add("café ☕\nadd tests")
    await h.run("open")
    expect(view.renderer.liveRequestCount).toBeGreaterThan(0)
    const pending = h.run("paste")
    await view.renderOnce()
    await pending
    expect(view.renderer.liveRequestCount).toBeGreaterThan(0)
    expect(input.plainText).toBe("existing: café ☕\nadd tests")
    expect(submissions).toBe(0)
    expect(h.external.snapshot().active).toEqual([])
    expect(h.external.snapshot().completed).toHaveLength(1)
    const open = h.layers.flatMap((layer) => layer().commands ?? []).find((command) => command.id === "opcode-later.open")
    expect(typeof open?.enabled === "function" ? open.enabled() : open?.enabled).toBe(true)
  } finally {
    view.renderer.dropLive()
    await view.dispose()
  }
})

test.each([40, 60])("compact manager keeps items, paste legend, and footer inside %i columns", async (width) => {
  const h = harness()
  h.external.add("narrow item")
  await h.run("open")
  const view = await testRender(() => createComponent(PluginContextProvider, {
    value: h.context,
    get children() { return h.routes[0]!.render({}) },
  }), { width, height: 18 })
  try {
    await view.flush()
    expect(view.captureCharFrame()).toContain("narrow item")
    expect(view.captureCharFrame()).toContain("paste+complete")
    expect(view.captureCharFrame()).toContain("esc back")
    expect(view.captureCharFrame()).toContain("Shared across projects")
    expect(view.captureCharFrame()).toContain("active only")
    expect(view.captureSpans().rows).toBe(18)
  } finally { await view.dispose() }
})

test("manager restores the original compact hierarchy, padded raised list, and split status footer", async () => {
  const h = harness()
  h.external.add("First active item", 1)
  h.external.add("Second active item", 2)
  const done = h.external.add("An older completed item", 3)
  h.external.complete(h.external.get(done)!, 4)
  await h.run("open")
  await h.run("down")
  await h.run("history")
  const view = await testRender(() => createComponent(PluginContextProvider, {
    value: h.context,
    get children() { return h.routes[0]!.render({}) },
  }), { width: 120, height: 30 })
  try {
    await view.flush()
    const lines = view.captureCharFrame().split("\n")
    const header = lines.findIndex((line) => line.includes("Later global list"))
    const filters = lines.findIndex((line) => line.includes("2 active / 1 completed"))
    expect(header).toBeGreaterThanOrEqual(0)
    expect(lines[header]).toContain("a add")
    expect(lines[header]).toContain("esc back")
    expect(filters).toBeGreaterThan(header)
    expect(filters - header).toBeLessThanOrEqual(2)
    expect(lines[filters]).toContain("h history")
    expect(lines[filters]).toContain("J/K reorder")
    const border = lines.findIndex((line) => /[┌╭]/.test(line))
    const bottom = lastIndex(lines, (line) => /[└╰]/.test(line))
    expect(border).toBeGreaterThan(filters)
    expect(border - filters).toBeLessThanOrEqual(2)
    expect(lines[border]!.search(/[┌╭]/)).toBeGreaterThan(0)
    expect(lines[border]!.search(/[┐╮]/)).toBeLessThan(lines[border]!.length - 1)
    const first = lines.findIndex((line) => line.includes("First active item"))
    const second = lines.findIndex((line) => line.includes("Second active item"))
    const history = lines.findIndex((line) => line.includes("COMPLETED HISTORY"))
    expect(first).toBeGreaterThan(border + 1)
    expect(second - first).toBeGreaterThanOrEqual(3)
    expect(lines[second]).toContain("> 2. Second active item")
    expect(history).toBeGreaterThan(second)
    expect(bottom).toBeGreaterThan(history)
    const footer = lines.findIndex((line) => line.includes("Changes are shared across projects"))
    expect(footer).toBeGreaterThan(bottom)
    expect(lastIndex(lines, (line) => line.trim())).toBe(footer)
    // Split footer: the status sits right of the description, at the card's right edge.
    const status = lines[footer]!.indexOf("history shown")
    expect(status).toBeGreaterThan(lines[footer]!.indexOf("instances.") + "instances.".length)
    expect(Math.abs(status + "history shown".length - 1 - lines[border]!.search(/[┐╮]/))).toBeLessThanOrEqual(1)
    expect(view.captureCharFrame()).not.toContain("Client-local list shared")
    const spans = view.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.find((span) => span.text.includes("Later"))?.fg.equals(h.api.theme.text.base)).toBe(true)
    expect(spans.find((span) => span.text.includes("First active item"))?.bg.equals(h.api.theme.background.raised.base)).toBe(true)
    expect(spans.find((span) => span.text.includes("Second active item"))?.bg.equals(h.api.theme.background.action.primary.selected)).toBe(true)
    expect(spans.find((span) => span.text.includes("Second active item"))?.fg.equals(h.api.theme.text.action.primary.selected)).toBe(true)
    expect(spans.find((span) => span.text.includes("2 active"))?.fg.equals(h.api.theme.hue.interactive[300])).toBe(true)
    expect(spans.find((span) => span.text.includes("1 completed"))?.fg.equals(h.api.theme.text.feedback.success.base)).toBe(true)
    expect(spans.find((span) => span.text.includes("COMPLETED HISTORY"))?.fg.equals(h.api.theme.hue.accent[300])).toBe(true)
  } finally { await view.dispose() }
})

test("empty manager centers title and hint within its bounded card and offers clickable back", async () => {
  const h = harness()
  await h.run("open")
  const view = await testRender(() => createComponent(PluginContextProvider, {
    value: h.context,
    get children() { return h.routes[0]!.render({}) },
  }), { width: 120, height: 30 })
  try {
    await view.flush()
    const lines = view.captureCharFrame().split("\n")
    const title = lines.findIndex((line) => line.includes("No items for later"))
    const hint = lines.findIndex((line) => line.includes("Press a to add one."))
    const top = lines.findIndex((line) => /[┌╭]/.test(line))
    const bottom = lastIndex(lines, (line) => /[└╰]/.test(line))
    const center = (lines[top]!.search(/[┌╭]/) + lines[top]!.search(/[┐╮]/)) / 2
    const middle = (text: string, row: number) => lines[row]!.indexOf(text) + (text.length - 1) / 2
    expect(title).toBeGreaterThan(top + 2)
    expect(Math.abs(title - (top + bottom) / 2)).toBeLessThanOrEqual(2)
    expect(Math.abs(middle("No items for later", title) - center)).toBeLessThanOrEqual(1)
    expect(Math.abs(middle("Press a to add one.", hint) - center)).toBeLessThanOrEqual(1)
    expect(hint).toBeGreaterThan(title)
    expect(hint).toBeLessThan(bottom)
    const footer = lastIndex(lines, (line) => line.trim())
    expect(footer).toBeGreaterThan(bottom)
    expect(lines[footer]).toContain("Changes are shared across projects")
    expect(lines[footer]).toContain("active only")
    const backY = lines.findIndex((line) => line.includes("esc back"))
    const backX = lines[backY]!.indexOf("esc back")
    await view.mockMouse.click(backX + 2, backY)
    expect(h.route()).toEqual({ type: "home" })
  } finally { await view.dispose() }
})

test("padded list rows wrap long messages without imposing the original three-line height cap", async () => {
  const h = harness()
  h.external.add(`${"wrap ".repeat(18)}END-OF-WRAP`)
  await h.run("open")
  const view = await testRender(() => createComponent(PluginContextProvider, {
    value: h.context,
    get children() { return h.routes[0]!.render({}) },
  }), { width: 60, height: 24 })
  try {
    await view.flush()
    const lines = view.captureCharFrame().split("\n")
    expect(lines.filter((line) => line.includes("wrap wrap")).length).toBeGreaterThanOrEqual(2)
    expect(view.captureCharFrame()).toContain("END-OF-WRAP")
    expect(view.captureCharFrame()).toContain("active only")
  } finally { await view.dispose() }
})
