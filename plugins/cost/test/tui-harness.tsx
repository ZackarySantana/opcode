/** @jsxImportSource @opentui/solid */

import type { Dashboard, DashboardFilter, TimeDashboard } from "../src/domain.js"
import type { LocationRef } from "@opencode/client"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Destination, DialogOptions, KeymapCommand, KeymapLayer } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createComputed, createRoot, createSignal, onCleanup, Show } from "solid-js"
import { mockTheme } from "@opcode/ui/test-support/host"
import type { Timers } from "../src/dialog.js"
import { createCostTui } from "../src/tui.js"

export function dashboard(cost = 2, projectLabel = "Alpha"): Dashboard {
  const day = "2026-07-10"
  return {
    total: { cost, messages: 1, tokens: 15, input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
    projects: [{ id: "p", label: projectLabel, cost, messages: 1, tokens: 15 }],
    models: [{ id: "provider/model", label: "provider/model", cost, messages: 1, tokens: 15 }],
    daily: [{ id: day, label: day, cost, messages: 1, tokens: 15 }],
    projectOptions: [{ id: "p", label: projectLabel, directory: "/remote/project" }], modelOptions: [{ id: "provider/model", label: "provider/model" }],
  }
}

/**
 * Host boundary only: the real plugin renders its dialog through the real OpenTUI renderer and plugin
 * context. Keymap layers leave with their owner, as in the host, and dispatch honors `enabled`.
 */
export async function createTuiHarness({ width = 120, height = 44 } = {}) {
  const [location, setLocation] = createSignal<LocationRef>({ directory: "/remote/project" })
  const [dialog, setDialog] = createSignal<{ render: () => JSX.Element; onClose?: () => void }>()
  let dialogOptions: DialogOptions | undefined
  const queries: Array<ReturnType<typeof Promise.withResolvers<Dashboard>> & { filter: DashboardFilter; signal: AbortSignal }> = []
  const times: Array<ReturnType<typeof Promise.withResolvers<TimeDashboard>> & { filter: DashboardFilter; signal: AbortSignal }> = []
  const navigations: Destination[] = []
  const usageListeners = new Set<() => void>()
  const layers = new Set<() => KeymapLayer>()
  const dispatch = (id: string) => [...layers].map((layer) => layer()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .flatMap((layer) => (layer.commands ?? []) as KeymapCommand[])
    .find((command) => command.id === id && (typeof command.enabled === "function" ? command.enabled() : command.enabled ?? true))?.run()
  // Test-driven clocks: `tick` fires active refresh intervals, `settle` fires pending debounces; read timeouts never fire.
  const intervals = new Set<() => void>()
  const debounces = new Set<{ run: () => void; ms: number }>()
  const timers: Timers = {
    interval: (run) => { const entry = () => run(); intervals.add(entry); return () => { intervals.delete(entry) } },
    timer: (run, ms) => {
      const entry = { run: () => { debounces.delete(entry); run() }, ms }
      debounces.add(entry)
      return () => { debounces.delete(entry) }
    },
  }
  const api = {
    get location() { return location() },
    renderer: { widthMethod: "unicode", once() {}, off() {}, requestRender() {} },
    theme: mockTheme({ panel: "#222222", border: "#667788" }),
    client: {
      rpc: () => ({
        status: async () => ({ projectID: "p", directory: "/remote/project", lastImport: null }),
        completeImport: async () => ({}),
        // Both deliberately ignore abort: callers must reject stale responses themselves.
        dashboard: (filter: DashboardFilter, options: { signal: AbortSignal }) => {
          const request = { ...Promise.withResolvers<Dashboard>(), filter, signal: options.signal }
          queries.push(request)
          return request.promise
        },
        time: (filter: DashboardFilter, options: { signal: AbortSignal }) => {
          const request = { ...Promise.withResolvers<TimeDashboard>(), filter, signal: options.signal }
          times.push(request)
          return request.promise
        },
      }),
      session: { list: async (..._: unknown[]): Promise<{ data: never[]; cursor: {} }> => ({ data: [], cursor: {} }) },
    },
    data: {
      on: (type: string, callback: () => void) => {
        if (type !== "session.usage.updated") return () => {}
        usageListeners.add(callback)
        return () => { usageListeners.delete(callback) }
      },
    },
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
    ui: {
      router: { navigate: (next: Destination) => { navigations.push(next) } },
      dialog: {
        show: (render: () => JSX.Element, onClose?: () => void) => { setDialog({ render, onClose }) },
        set: (options: DialogOptions) => { dialogOptions = options },
        clear: () => {
          const open = dialog()
          setDialog(undefined)
          open?.onClose?.()
        },
      },
      toast: { show() {} },
    },
  }
  const root = createRoot((dispose) => ({ dispose, result: createCostTui(timers).setup(api as never) }))
  const stop = await root.result
  if (!stop) throw new Error("Missing plugin cleanup")
  // Finish the mocked startup import before callers start controlling dashboard requests.
  await Bun.sleep(0)
  const scene = await testRender(() => (
    <PluginContextProvider value={api as never}>
      <Show when={dialog()} keyed>{(open) => open.render()}</Show>
    </PluginContextProvider>
  ), { width, height })
  let stopped = false
  const unload = async () => {
    if (stopped) return
    stopped = true
    root.dispose()
    await stop()
  }
  const run = (name: string) => dispatch(`opcode-cost.${name}`)
  return {
    api, scene, queries, times, navigations, usageListeners, intervals, debounces, setLocation, run, unload,
    open: () => run("open"),
    isOpen: () => dialog() !== undefined,
    dialogOptions: () => dialogOptions,
    frame: (predicate: (frame: string) => boolean) => scene.waitForFrame(predicate),
    emitUsage: () => { for (const callback of usageListeners) callback() },
    tick: () => { for (const run of [...intervals]) run() },
    settle: () => { for (const entry of [...debounces]) if (entry.ms === 100) entry.run() },
    cleanup: async () => { await scene.dispose(); await unload() },
  }
}
