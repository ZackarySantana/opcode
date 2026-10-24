import "@opentui/solid/preload"
import { afterEach, expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, KeymapCommand, KeymapLayer, Route, SlotClaim } from "@opencode/plugin/tui/context"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { join } from "node:path"
import { createComponent, createComputed, createSignal, getOwner, onCleanup, type JSX } from "solid-js"
import { mockTheme, tempDir } from "@opcode/ui/test-support/host"
import { LaterDatabase } from "../src/sqlite"

// Load JSX after installing the OpenTUI Solid transform. This file itself has no JSX.
const { default: plugin } = await import("../src/tui")
const cleanup: Array<() => void> = []
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop() })

function harness(sidebarItems?: number) {
  const directory = tempDir("opcode-later-tui-")
  cleanup.push(directory.remove)
  const path = join(directory.path, "later.sqlite")
  const external = new LaterDatabase(path)
  cleanup.push(() => external.close())
  if (sidebarItems) external.saveSettings({ sidebarItems, agentTools: true })
  const route: Route = { type: "home" }
  let prompt: string | undefined
  const [dialog, setDialog] = createSignal<{ render: () => JSX.Element; onClose?: () => void }>()
  // Layers leave with their owner, as in the host, so commands of an unmounted tab can't run.
  const layers = new Set<() => KeymapLayer>()
  const commands = () => [...layers].map((layer) => layer()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .flatMap((layer) => (layer.commands ?? []) as KeymapCommand[])
  const enabled = (command: KeymapCommand) => typeof command.enabled === "function" ? command.enabled() : command.enabled ?? true
  const dispatch = async (id: string) => { await commands().find((command) => command.id === id && enabled(command))?.run() }
  const slots: SlotClaim[] = []
  const api = {
    options: { database: path },
    renderer: { isDestroyed: false, widthMethod: "unicode", once: () => {}, off: () => {}, requestRender: () => {} },
    theme: mockTheme(),
    ui: {
      router: { current: () => route, navigate: () => {} },
      slot: (slot: SlotClaim) => { slots.push(slot); return () => { slots.splice(slots.indexOf(slot), 1) } },
      toast: { show: () => {} },
      dialog: {
        show: (render: () => JSX.Element, onClose?: () => void) => { const replaced = dialog(); setDialog({ render, onClose }); replaced?.onClose?.() },
        set: () => {},
        clear: () => { const closed = dialog(); setDialog(undefined); closed?.onClose?.() },
        prompt: async () => { api.ui.dialog.clear(); return prompt },
        confirm: async () => { api.ui.dialog.clear(); return true },
      },
    },
    keymap: {
      dispatch,
      layer: (factory: () => KeymapLayer) => {
        let current: KeymapLayer = {}
        const layer = () => current
        if (getOwner()) createComputed(() => { current = factory() })
        else current = factory()
        layers.add(layer)
        if (getOwner()) onCleanup(() => layers.delete(layer))
      },
      mode: { current: () => dialog() ? "modal" : "base" },
      commands: () => dialog() ? [] : [{ id: "prompt.paste" }],
    },
  }
  const context = api as unknown as Context
  const stop = plugin.setup(context) as () => void
  cleanup.push(stop)
  const render = (children: () => JSX.Element, size: { width: number; height: number }) =>
    testRender(() => createComponent(PluginContextProvider, { value: context, get children() { return children() } }), size)
  return {
    api, context, external, slots, stop, commands, dispatch, render,
    dialog,
    prompt: (value: string) => { prompt = value },
  }
}

test("/later opens the dialog, and unloading closes it and removes the sidebar", () => {
  const h = harness()
  expect(h.commands().find((command) => command.id === "opcode-later.open")).toMatchObject({ palette: true, slash: { name: "later" } })
  expect(h.slots[0]?.after).toBe("sidebar.content")
  h.dispatch("opcode-later.open")
  expect(h.dialog()).toBeDefined()
  h.stop()
  expect(h.dialog()).toBeUndefined()
  expect(h.slots).toEqual([])
})

test("the dialog adds, reorders, completes, deletes, and restores from its tabs, and keeps a sidebar setting", async () => {
  const h = harness()
  h.dispatch("opcode-later.open")
  // The dialog's content is rendered again after each native prompt replaces it, as the host does.
  const view = await h.render(() => h.dialog()?.render(), { width: 110, height: 40 })
  const frame = (match: (frame: string) => boolean) => view.waitForFrame(match)
  const items = () => h.external.snapshot().active.map((item) => item.message)
  try {
    expect(await frame((frame) => frame.includes("Nothing saved for later"))).toMatch(/Later[\s\S]*History[\s\S]*Settings/)
    for (const text of ["first", "second"]) {
      h.prompt(text)
      await h.dispatch("opcode-later.add")
    }
    await frame((frame) => frame.includes("second"))
    // A new item is outlined, so shift+k moves it up.
    await h.dispatch("opcode-later.move.up")
    expect(items()).toEqual(["second", "first"])
    await h.dispatch("opcode-later.complete")
    // History lists newest first, and completions within one millisecond tie on random ids.
    for (const completed = Date.now(); Date.now() === completed;) await Bun.sleep(1)
    await h.dispatch("opcode-later.complete")
    expect(items()).toEqual([])

    await h.dispatch("opcode-later.next")
    await frame((frame) => frame.includes("COMPLETED") && frame.includes("second"))
    // Confirming replaces the dialog, which comes back on History.
    await h.dispatch("opcode-later.delete")
    expect(await frame((frame) => !frame.includes("first"))).toContain("COMPLETED")
    await h.dispatch("opcode-later.activate")
    expect(items()).toEqual(["second"])

    await h.dispatch("opcode-later.next")
    await frame((frame) => frame.includes("Sidebar items"))
    await h.dispatch("opcode-later.adjust.next")
    expect(h.external.settings().sidebarItems).toBe(10)
    // Escape closes the dialog once the search box is empty; /later opens again on its first tab.
    await h.dispatch("opcode-later.close")
    expect(h.dialog()).toBeUndefined()
    await h.dispatch("opcode-later.open")
    expect(await frame((frame) => frame.includes("ACTIVE"))).toContain("second")
  } finally { await view.dispose() }
})

test("the sidebar mutes items, lists the configured number, and points to /later for the rest", async () => {
  const h = harness(3)
  const slot = h.slots[0] as SlotClaim<"sidebar.content">
  const view = await h.render(() => slot.render({ sessionID: "any-session" }), { width: 42, height: 14 })
  try {
    await view.flush()
    expect(view.captureCharFrame()).not.toContain("Later")
    for (let index = 1; index <= 6; index++) h.external.add(`item ${index}`, index)
    // No command: setup's polling must pick up another client's items.
    for (const deadline = Date.now() + 2000; Date.now() < deadline && !view.captureCharFrame().includes("+3 more");) {
      await Bun.sleep(25)
      await view.flush()
    }
    const frame = view.captureCharFrame()
    expect(frame).toContain("item 3")
    expect(frame).not.toContain("item 4")
    const spans = view.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.find((span) => span.text.includes("item 1"))?.fg.equals(h.api.theme.text.muted)).toBe(true)
    const lines = frame.split("\n")
    const y = lines.findIndex((line) => line.includes("/later"))
    let opened = false
    h.api.keymap.dispatch = async (id: string) => { opened = id === "opcode-later.open" }
    await view.mockMouse.click(lines[y]!.indexOf("/later"), y)
    expect(opened).toBe(true)
  } finally { await view.dispose() }
})

test("real OpenTUI paste from the dialog preserves prompt text and never submits", async () => {
  const h = harness()
  const view = await createTestRenderer({ width: 60, height: 12 })
  let submissions = 0
  const input = new TextareaRenderable(view.renderer, { id: "test-prompt", width: 60, height: 6, onSubmit: () => { submissions++ } })
  view.renderer.root.add(input)
  input.focus()
  input.insertText("existing: ")
  Object.assign(h.api, { renderer: view.renderer })
  try {
    h.external.add("café ☕\nadd tests")
    h.dispatch("opcode-later.open")
    const dialog = await h.render(() => h.dialog()?.render(), { width: 100, height: 30 })
    try {
      await dialog.waitForFrame((frame) => frame.includes("café"))
      await h.dispatch("opcode-later.activate")
      for (const deadline = Date.now() + 2000; Date.now() < deadline && h.external.snapshot().active.length;) await view.renderOnce()
    } finally { await dialog.dispose() }
    expect(h.dialog()).toBeUndefined()
    expect(input.plainText).toBe("existing: café ☕\nadd tests")
    expect(submissions).toBe(0)
    expect(h.external.snapshot().completed).toHaveLength(1)
  } finally { await view.dispose() }
})
