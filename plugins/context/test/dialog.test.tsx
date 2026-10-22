/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionMessageInfo } from "@opencode/client"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, KeymapLayer } from "@opencode/plugin/tui/context"
import { RGBA, type KeyEvent } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import { createComputed, createSignal, getOwner, onCleanup } from "solid-js"
import plugin, { currentSessionID } from "../src/tui"
import server from "../src/index"
import { ContextRpc } from "../src/rpc"
import { cellWidth, shorten } from "../src/view"
import { deferred, mockHost } from "./helpers"

async function openDialog(options: {
  width?: number; height?: number; modalWidth?: number; failContext?: boolean; noSession?: boolean
  tools?: { id: string; description?: string }[]
  retained?: () => Promise<SessionMessageInfo[]>
} = {}) {
  const { host, history } = mockHost()
  const layers: KeymapLayer[] = []
  const liveLayers: boolean[] = []
  const layerRuns: number[] = []
  const scopes = { entered: [] as string[], left: 0 }
  let currentMode = "base"
  const pendingCommands: Promise<unknown>[] = []
  const reachable = () => layers.map((layer, index) => ({ layer, index }))
    .filter(({ layer, index }) => liveLayers[index] && (layer.mode === "global" || (layer.mode ?? "base") === currentMode))
    .sort((a, b) => (b.layer.priority ?? 0) - (a.layer.priority ?? 0))
    .flatMap(({ layer }) => layer.commands ?? [])
  const dispatch = (id: string) => {
    const command = reachable().find((command) => command.id === id)
    if (!command) return Promise.resolve()
    const pending = Promise.resolve(command.run())
    pendingCommands.push(pending)
    return pending
  }
  const tools = options.tools ?? Array.from({ length: 60 }, (_, index) => ({ id: `tool-${String(index).padStart(2, "0")}`, description: "A tool" }))
  history.splice(0, history.length, {
    id: "assistant", type: "assistant", time: { created: 1 }, agent: "build", model: { providerID: "p", id: "m" },
    content: tools.map((tool, index) => ({ type: "tool", id: tool.id, name: tool.id, time: { created: 1 },
      state: { status: "completed", input: {}, content: [{ type: "text", text: "x".repeat((60 - index) * 4) }] } })),
  } satisfies SessionMessageInfo)
  host.client.rpc = () => ({ tools: async () => tools })
  let reads = 0
  host.client.session.context = async () => { reads++; if (options.failContext) throw new Error("offline"); return options.retained ? options.retained() : history }
  let failRead = false
  host.data.location.model.list = () => { if (failRead) throw new Error("Unexpected catalog failure"); return [] }
  const toasts: { variant: string; title?: string; message: string }[] = []
  let render: (() => JSX.Element) | undefined, onClose: (() => void) | undefined
  let listener: ((event: { details: { data: { sessionID: string } } }) => void) | undefined
  let stopped = false, cleared = false
  const theme = {
    hue: { accent: { 300: "#77cccc", 600: "#336666" }, interactive: { 300: "cyan" } },
    background: { base: "#171717", raised: { base: "#262626" }, action: { primary: { selected: "#ffaf87" } } }, border: { base: "#666666" },
    text: { base: "white", muted: "#808080", action: { primary: { base: "white", selected: "#171717" } },
      feedback: { success: { base: "green" }, warning: { base: "yellow" }, error: { base: "red" } } },
  }
  const context = {
    ...host,
    renderer: { widthMethod: "unicode" },
    theme: { ...theme, background: { base: "#080808", raised: { base: "#101010" } }, surface: () => theme },
    keymap: {
      layer: (factory: () => KeymapLayer) => {
        const index = layers.length
        layers.push({})
        liveLayers.push(true)
        layerRuns.push(0)
        createComputed(() => { layers[index] = factory(); layerRuns[index] = layerRuns[index]! + 1 })
        if (getOwner()) onCleanup(() => { liveLayers[index] = false })
      },
      dispatch,
      commands: reachable,
      mode: {
        current: () => currentMode,
        push: (mode: string) => {
          const previous = currentMode
          currentMode = mode
          scopes.entered.push(mode)
          return () => { currentMode = previous; scopes.left++ }
        },
      },
    },
    data: { ...host.data, listen: (callback: typeof listener) => { listener = callback; return () => { stopped = true } } },
    ui: {
      router: { current: () => options.noSession ? { type: "home" } : { type: "session", sessionID: "s" } },
      dialog: {
        show: (callback: () => JSX.Element, close?: () => void) => { render = callback; onClose = close },
        set: () => {}, clear: () => { cleared = true; onClose?.() },
      },
      toast: { show: (toast: typeof toasts[number]) => { toasts.push(toast) } },
    },
  } as unknown as Context
  const cleanup = await plugin.setup(context)
  const open = layers[0]!.commands![0]!
  await open.run()
  const [modalWidth, setModalWidth] = createSignal<number | "100%">(options.modalWidth ?? "100%")
  const view = await testRender(() => <box width={modalWidth()}><PluginContextProvider value={context}>{render?.()}</PluginContextProvider></box>, { width: options.width ?? 110, height: options.height ?? 42 })
  // The native host installs its dialog mode after the dialog component mounts.
  currentMode = "modal"
  const handleKey = (event: KeyEvent) => {
    if (event.ctrl || event.meta || event.shift) return
    const command = reachable().find((command) => typeof command.bind === "string" && command.bind.split(",").includes(event.name))
    if (command?.id) { event.preventDefault(); void dispatch(command.id) }
  }
  view.renderer.keyInput.on("keypress", handleKey)
  const flushCommands = async () => { await Promise.all(pendingCommands.splice(0)); await view.flush() }
  const run = async (suffix: string) => { await dispatch(`opcode-context.${suffix}`); await flushCommands() }
  const click = async (text: string, button: 0 | 1 | 2 = 0) => {
    await view.flush()
    const lines = view.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    if (y < 0) throw new Error(`Click target not rendered: ${text}`)
    const line = lines[y]!
    const x = cellWidth(line.slice(0, line.indexOf(text))) + Math.floor(cellWidth(text) / 2)
    await view.mockMouse.click(x, y, button)
    await flushCommands()
  }
  return {
    view, run, click, history, tools, toasts, setModalWidth, layerRuns, scopes, reads: () => reads,
    mode: () => currentMode,
    reachable: () => reachable().map((command) => command.id),
    async press(key: string) {
      await view.mockInput.pressKeys([key])
      if (key === "ESCAPE") await Bun.sleep(150) // Allow the terminal parser to disambiguate a lone Escape.
      await flushCommands()
    },
    failReads: (fail: boolean) => { failRead = fail },
    emit: (sessionID: string) => listener?.({ details: { data: { sessionID } } }),
    closed: () => cleared, cleaned: () => stopped && scopes.entered.length === 0 && scopes.left === 0,
    async dispose() { view.renderer.keyInput.off("keypress", handleKey); await view.dispose(); await cleanup?.() },
  }
}

test("both lists retain selection and Unicode details in a constrained modal after resize and shrink", async () => {
  const description = "資料👩‍💻e\u0301".repeat(12)
  const tools = Array.from({ length: 60 }, (_, index) => ({ id: `tool-${String(index).padStart(2, "0")}-${"東京👩‍💻e\u0301".repeat(8)}`, description }))
  const dialog = await openDialog({ modalWidth: 52, tools })
  try {
    await dialog.view.waitForFrame((frame) => frame.includes("RECORDED INPUT"))
    await dialog.run("next")
    await dialog.view.waitForFrame((frame) => frame.includes("Tool: tool-00"))
    for (let index = 0; index < 45; index++) await dialog.run("down")
    await dialog.view.waitForFrame((frame) => frame.includes("> Tool: tool-45"))
    expect(dialog.view.captureCharFrame()).not.toContain("Tool: tool-00")
    expect(dialog.view.captureCharFrame()).toContain("~15 tok")
    expect(dialog.view.captureCharFrame()).toContain("東京👩‍💻e\u0301")
    dialog.setModalWidth(42)
    dialog.view.resize(62, 26)
    const contentFrame = await dialog.view.waitForFrame((frame) => frame.includes("> Tool: tool-45") && frame.includes("~15 tok"))
    for (const line of contentFrame.split("\n").filter((line) => line.includes("Tool: tool-"))) expect(cellWidth(line.trimEnd())).toBeLessThanOrEqual(42)
    const assistant = dialog.history[0]!
    if (assistant.type !== "assistant") throw new Error("Expected assistant fixture")
    dialog.history.splice(0, dialog.history.length, { ...assistant, content: assistant.content.slice(0, 3) })
    await dialog.run("refresh")
    await dialog.view.waitForFrame((frame) => frame.includes("> Tool: tool-02"))
    await dialog.run("next")
    for (let index = 0; index < 50; index++) await dialog.run("down")
    const environmentFrame = await dialog.view.waitForFrame((frame) => frame.includes("> tool: tool-45") && frame.includes(shorten(description, 10)))
    expect(environmentFrame).not.toContain("tool: tool-00")
    for (const line of environmentFrame.split("\n").filter((line) => line.includes("tool:"))) expect(cellWidth(line.trimEnd())).toBeLessThanOrEqual(42)
    dialog.tools.splice(3)
    await dialog.run("refresh")
    await dialog.view.waitForFrame((frame) => frame.includes("> tool: tool-02"))
  } finally { await dialog.dispose() }
  expect(dialog.cleaned()).toBe(true)
})

test("narrow modal visibly marks missing retained context instead of estimating history", async () => {
  const dialog = await openDialog({ width: 62, height: 36, failContext: true })
  try {
    await dialog.view.waitForFrame((frame) => frame.includes("Degraded") && frame.includes("Estimated utilization"))
    expect(dialog.view.captureCharFrame()).toContain("unavailable")
    await dialog.run("next")
    await dialog.view.waitForFrame((frame) => frame.includes("Retained context unavailable"))
  } finally { await dialog.dispose() }
})

test("92×38 initially shows the complete Overview, activity values, provenance, and limitations without scrolling", async () => {
  const dialog = await openDialog({ width: 92, height: 38 })
  try {
    const frame = await dialog.view.waitForFrame((value) => value.includes("RECORDED INPUT") && !value.includes("refreshing"))
    expect(frame.split("\n").some((line) => line.includes("RECORDED INPUT") && line.includes("CACHE"))).toBe(true)
    expect(frame.split("\n").some((line) => line.includes("OUTPUT") && line.includes("RETAINED EST."))).toBe(true)
    for (const text of ["p/m", "Context limit", "Estimated utilization", "ACTIVITY", "Messages: 0 user / 1 assistant",
      "Tools / compactions: 60 / 0", "Latest checkpoint: unavailable", "History: live", "Retained: estimated",
      "Provider tokens are recorded", "retained size and utilization are estimated", "Excludes hidden instructions, tool schemas & attachment payloads.",
      "h/l tabs", "r refresh", "e export"]) expect(frame).toContain(text)
  } finally { await dialog.dispose() }
})

test("real key events reach dialog commands while the native dialog mode is current", async () => {
  const dialog = await openDialog({ width: 92, height: 38 })
  try {
    await dialog.view.waitForFrame((frame) => frame.includes("RECORDED INPUT"))
    expect(dialog.mode()).toBe("modal")
    expect(dialog.scopes.entered).toEqual([])
    await dialog.press("l")
    await dialog.view.waitForFrame((frame) => frame.includes("LARGEST RETAINED CONTRIBUTORS"))
    await dialog.press("j")
    await dialog.view.waitForFrame((frame) => frame.includes("> Tool: tool-01"))
    await dialog.press("k")
    await dialog.view.waitForFrame((frame) => frame.includes("> Tool: tool-00"))
    await dialog.press("ARROW_RIGHT")
    await dialog.view.waitForFrame((frame) => frame.includes("OBSERVABLE ENVIRONMENT"))
    await dialog.press("h")
    await dialog.view.waitForFrame((frame) => frame.includes("LARGEST RETAINED CONTRIBUTORS"))
    await dialog.press("ARROW_LEFT")
    await dialog.view.waitForFrame((frame) => frame.includes("RECORDED INPUT"))
    await dialog.press("r")
    expect(dialog.reads()).toBe(2)
    await dialog.press("ESCAPE")
    await dialog.view.waitFor(dialog.closed)
    expect(dialog.closed()).toBe(true)
  } finally { await dialog.dispose() }
})

test("rendered tab pills, footer hints, and close affordance handle actual left mouse clicks", async () => {
  const dialog = await openDialog({ width: 92, height: 38 })
  try {
    await dialog.view.waitForFrame((frame) => frame.includes("RECORDED INPUT"))
    await dialog.click("Environment")
    await dialog.view.waitForFrame((frame) => frame.includes("OBSERVABLE ENVIRONMENT"))
    await dialog.click("Overview", 2)
    expect(dialog.view.captureCharFrame()).toContain("OBSERVABLE ENVIRONMENT")
    await dialog.click("Overview")
    await dialog.view.waitForFrame((frame) => frame.includes("RECORDED INPUT"))
    await dialog.click("h/l tabs")
    await dialog.view.waitForFrame((frame) => frame.includes("LARGEST RETAINED CONTRIBUTORS"))
    await dialog.click("j/k rows")
    await dialog.view.waitForFrame((frame) => frame.includes("> Tool: tool-01"))
    await dialog.click("r refresh")
    expect(dialog.reads()).toBe(2)
    await dialog.click("esc close", 2)
    expect(dialog.closed()).toBe(false)
    await dialog.click("esc close")
    expect(dialog.closed()).toBe(true)
  } finally { await dialog.dispose() }
})

test("bordered Overview cards stack narrowly and restore the original two-by-two grid when wide", async () => {
  const dialog = await openDialog({ width: 62, height: 42 })
  try {
    const frame = await dialog.view.waitForFrame((value) => value.includes("RECORDED INPUT") && value.includes("CACHE"))
    const lines = frame.split("\n")
    expect(lines.findIndex((line) => line.includes("RECORDED INPUT")))
      .toBeLessThan(lines.findIndex((line) => line.includes("CACHE")))
    for (let index = 0; index < 60; index++) await dialog.run("down")
    await dialog.view.waitForFrame((value) => value.includes("Excludes hidden instructions"))
    dialog.view.resize(110, 42)
    for (let index = 0; index < 100; index++) await dialog.run("up")
    const wide = await dialog.view.waitForFrame((value) => value.split("\n").some((line) => line.includes("RECORDED INPUT") && line.includes("CACHE")))
    expect(wide.split("\n").some((line) => line.includes("OUTPUT") && line.includes("RETAINED EST."))).toBe(true)
    expect(wide).toContain("ACTIVITY")
    expect(wide).toContain("Messages:")
    expect(wide).toContain("fresh")
    expect(wide).toContain("reasoning")
    expect(wide).toContain("read efficiency")
    expect(wide).toContain("chars")
    expect(wide.split("\n").some((line) => line.includes("Current context") && line.includes("s") && line.includes("esc close"))).toBe(true)
    expect(wide).toMatch(/[┌╭].*[┐╮]/)
    const spans = dialog.view.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.some((span) => span.bg.equals(RGBA.fromHex("#171717")))).toBe(true)
    expect(spans.some((span) => span.text.includes("Overview") && span.fg.equals(RGBA.fromHex("#00ffff")))).toBe(true)
    expect(spans.some((span) => span.text.includes("Content") && !span.fg.equals(RGBA.fromHex("#00ffff")))).toBe(true)
    expect(spans.some((span) => span.text.includes("RECORDED INPUT") && span.fg.equals(RGBA.fromHex("#808080")))).toBe(true)
    expect(spans.some((span) => span.text.includes("RECORDED INPUT") && span.bg.equals(RGBA.fromHex("#262626")))).toBe(true)
    expect(spans.some((span) => span.text.includes("Current context") && span.fg.equals(RGBA.fromHex("#ffffff")))).toBe(true)
    for (let index = 0; index < 60; index++) await dialog.run("down")
    const bottom = await dialog.view.waitForFrame((value) => value.includes("Latest checkpoint:") && value.includes("Excludes hidden instructions"))
    expect(bottom).toContain("Tools / compactions:")
    expect(bottom).toContain("History: live")
    expect(bottom).toContain("Retained: estimated")
    expect(bottom).toContain("h/l tabs")
    expect(bottom).toContain("r refresh")
    expect(bottom).toContain("e export")
    await dialog.run("next")
    await dialog.view.waitForFrame((value) => value.includes("> Tool: tool-00"))
    const selected = dialog.view.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("> Tool: tool-00"))
    expect(selected?.fg.equals(RGBA.fromHex("#171717"))).toBe(true)
    expect(selected?.bg.equals(RGBA.fromHex("#ffaf87"))).toBe(true)
  } finally { await dialog.dispose() }
})

test("refreshes preserve native dialog mode and component-owned keyboard registrations", async () => {
  const dialog = await openDialog()
  try {
    await dialog.view.waitForFrame((frame) => frame.includes("RECORDED INPUT"))
    const registrations = [...dialog.layerRuns]
    expect(dialog.scopes.entered).toEqual([])
    expect(dialog.mode()).toBe("modal")
    expect(dialog.scopes.left).toBe(0)
    await dialog.run("refresh")
    expect(dialog.reads()).toBe(2)
    dialog.emit("other"); await Bun.sleep(160)
    expect(dialog.reads()).toBe(2)
    dialog.emit("s"); dialog.emit("s"); await Bun.sleep(160)
    expect(dialog.reads()).toBe(3)
    expect(dialog.layerRuns).toEqual(registrations)
    expect(dialog.scopes.entered).toEqual([])
    await dialog.run("close")
    expect(dialog.closed()).toBe(true)
  } finally { await dialog.dispose() }
  expect(dialog.cleaned()).toBe(true)
  expect(dialog.scopes.left).toBe(0)
  expect(dialog.reachable()).not.toContain("opcode-context.refresh")
})

test("home route shows an empty state without requesting session data", async () => {
  const dialog = await openDialog({ noSession: true })
  try {
    await dialog.view.waitForFrame((frame) => frame.includes("Open a session"))
    expect(dialog.reads()).toBe(0)
  } finally { await dialog.dispose() }
})

test("export command guards loading and stale data, writes private metadata, and reports filesystem failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "context-command-"))
  const previous = process.env.XDG_STATE_HOME
  const pending = deferred<SessionMessageInfo[]>()
  let dialog: Awaited<ReturnType<typeof openDialog>> | undefined
  process.env.XDG_STATE_HOME = root
  try {
    dialog = await openDialog({ retained: () => pending.promise })
    await dialog.press("e")
    expect(dialog.toasts.at(-1)?.variant).toBe("warning")
    await dialog.click("e export")
    expect(dialog.toasts.at(-1)).toMatchObject({ variant: "warning", message: "Refresh successfully before exporting a context snapshot." })
    expect(await readdir(root)).toEqual([])
    pending.resolve(dialog.history)
    await dialog.view.waitForFrame((frame) => frame.includes("RECORDED INPUT"))
    await dialog.click("e export")
    const success = dialog.toasts.at(-1)!
    expect(success).toMatchObject({ variant: "success", title: "Context exported" })
    const exports = join(root, "opencode/opcode-context/exports")
    expect(success.message.startsWith(`${exports}/`)).toBe(true)
    expect((await stat(success.message)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(success.message, "utf8"))).toMatchObject({ sessionID: "s", version: 1, toolCalls: 60 })
    dialog.failReads(true)
    await dialog.run("refresh")
    await dialog.view.waitForFrame((frame) => frame.includes("Refresh failed"))
    await dialog.click("e export")
    expect(dialog.toasts.at(-1)?.variant).toBe("warning")
    expect(await readdir(exports)).toHaveLength(1)
    dialog.failReads(false)
    await dialog.run("refresh")
    const blocker = join(root, "not-a-directory")
    await writeFile(blocker, "file")
    process.env.XDG_STATE_HOME = blocker
    await dialog.click("e export")
    expect(dialog.toasts.at(-1)).toMatchObject({ variant: "error", title: "Export failed" })
    expect(dialog.toasts.at(-1)?.message).toBeTruthy()
    expect(await readdir(exports)).toHaveLength(1)
  } finally {
    await dialog?.dispose()
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test("unload does not close a replacement dialog, and router session lookup is explicit", async () => {
  let command: KeymapLayer["commands"], onClose: (() => void) | undefined, cleared = false
  const cleanup = await plugin.setup({
    keymap: { layer: (factory: () => KeymapLayer) => { command = factory().commands } },
    ui: {
      router: { current: () => ({ type: "home" }) },
      dialog: { show: (_render: unknown, callback: () => void) => { onClose = callback }, set: () => {}, clear: () => { cleared = true } },
    },
  } as never)
  expect(command?.[0]?.slash?.name).toBe("context")
  expect(command?.[0]?.palette).toBe(true)
  await command?.[0]?.run()
  onClose?.()
  await cleanup?.()
  expect(cleared).toBe(false)
  expect(currentSessionID({ ui: { router: { current: () => ({ type: "session", sessionID: "s" }) } } } as never)).toBe("s")
  expect(currentSessionID({ ui: { router: { current: () => ({ type: "home" }) } } } as never)).toBeUndefined()
})

test("server RPC returns only read-only tool metadata with the new ID", async () => {
  let handler: (() => Promise<unknown>) | undefined
  await server.setup({
    rpc: { register: async (definition: unknown, handlers: { tools: () => Promise<unknown> }) => {
      expect(definition).toBe(ContextRpc); handler = handlers.tools
    } },
    tool: { list: async () => [{ id: "read", description: "Read", execute: () => { throw new Error("Catalog inspection must not execute tools") }, input: {} }] },
  } as never)
  expect(plugin.id).toBe("opcode-context")
  expect(server.id).toBe(plugin.id)
  expect(ContextRpc.id).toBe("opcode-context")
  expect(await handler?.()).toEqual([{ id: "read", description: "Read" }])
})
