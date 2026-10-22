import type { Dashboard, DashboardFilter } from "../src/domain.js"
import type { Destination, DialogSelectOptions, KeymapLayer, Page, Route } from "@opencode/plugin/tui/context"
import { createRoot, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { mockTheme } from "@opcode/ui/test-support/host"
import { createCostTui, type Timers } from "../src/tui.js"
import { PLUGIN_ID } from "../src/navigation.js"

export function dashboard(cost = 2, projectLabel = "Alpha", day = "2026-07-10"): Dashboard {
  return {
    total: { cost, messages: 1, tokens: 15, input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
    projects: [{ id: "p", label: projectLabel, cost, messages: 1, tokens: 15 }],
    models: [{ id: "provider/model", label: "provider/model", cost, messages: 1, tokens: 15 }],
    daily: [{ id: day, label: day, cost, messages: 1, tokens: 15 }],
    projectOptions: [{ id: "p", label: projectLabel, directory: "/remote/project" }], modelOptions: [{ id: "provider/model", label: "provider/model" }],
  }
}

/** Host boundary only: rendering tests use the real OpenTUI renderer and plugin context provider. */
export async function createTuiHarness(initial: Route = { type: "home" }, mutableRoutes = false) {
  const [signalRoute, setSignalRoute] = createSignal<Route>(initial)
  const [store, setStore] = createStore({ route: structuredClone(initial) })
  const route = () => mutableRoutes ? store.route : signalRoute()
  const setRoute = (next: Route) => {
    if (mutableRoutes) setStore("route", reconcile(next, { key: null }))
    else setSignalRoute(next)
  }
  const [location, setLocation] = createSignal({ directory: "/remote/project" })
  const queries: Array<ReturnType<typeof Promise.withResolvers<Dashboard>> & { filter: DashboardFilter; signal: AbortSignal }> = []
  const dialogs: Array<ReturnType<typeof Promise.withResolvers<string | undefined>> & { options: DialogSelectOptions<string> }> = []
  const navigations: Destination[] = []
  const layers: KeymapLayer[] = []
  const usageListeners = new Set<() => void>()
  const toasts: string[] = []
  let modes = 0
  // Test-driven clocks: `tick` fires active refresh intervals, `settle` fires pending debounces.
  const intervals = new Set<() => void>()
  const debounces = new Set<() => void>()
  const timers: Timers = {
    interval: (run) => { const entry = () => run(); intervals.add(entry); return () => { intervals.delete(entry) } },
    debounce: (run) => {
      const entry = () => { debounces.delete(entry); run() }
      debounces.add(entry)
      return () => { debounces.delete(entry) }
    },
  }
  let page!: Page
  let unregistered = false
  const api = {
    get location() { return location() },
    renderer: { widthMethod: "unicode" },
    theme: mockTheme({ panel: "#222222", border: "#667788" }),
    client: {
      rpc: () => ({
        status: async () => ({ projectID: "p", directory: "/remote/project", lastImport: null }),
        completeImport: async () => ({}),
        dashboard: (filter: DashboardFilter, options: { signal: AbortSignal }) => {
          const request = { ...Promise.withResolvers<Dashboard>(), filter, signal: options.signal }
          queries.push(request)
          return request.promise // Deliberately ignores abort: callers must reject stale responses themselves.
        },
      }),
      session: { list: async () => ({ data: [], cursor: {} }) },
    },
    data: { on: (_type: string, callback: () => void) => { usageListeners.add(callback); return () => { usageListeners.delete(callback) } } },
    keymap: {
      layer: (factory: () => KeymapLayer) => { layers.push(factory()) },
      dispatch: (id: string) => { void layers.flatMap((layer) => layer.commands ?? []).find((item) => item.id === id)?.run() },
      mode: { push: () => { modes++; return () => { modes-- } } },
    },
    ui: {
      router: {
        current: route,
        register: (value: Page) => { page = value; return () => { unregistered = true } },
        navigate: (next: Destination) => {
          navigations.push(next)
          setRoute(next.type === "plugin" ? { ...next, id: "id" in next ? next.id : PLUGIN_ID } : next)
        },
      },
      // These controlled promises may resolve after another dialog replaces them, like a delayed host callback.
      dialog: {
        clear: () => undefined,
        select: (options: DialogSelectOptions<string>) => {
          const selection = { ...Promise.withResolvers<string | undefined>(), options }
          dialogs.push(selection)
          return selection.promise
        },
      },
      toast: { show: ({ message }: { message: string }) => { toasts.push(message) } },
    },
  }
  const root = createRoot((dispose) => ({ dispose, result: createCostTui(timers).setup(api as never) }))
  const stop = await root.result
  if (!stop) throw new Error("Missing plugin cleanup")
  let stopped = false
  const cleanup = async () => {
    if (stopped) return
    stopped = true
    root.dispose()
    await stop()
  }
  const run = async (id: string) => {
    const command = layers.flatMap((layer) => layer.commands ?? []).find((item) => item.id === `opcode-cost.${id}`)
    if (!command) throw new Error(`Missing command ${id}`)
    await command.run()
  }
  // Finish the mocked startup import before callers start controlling dashboard requests.
  await Bun.sleep(0)
  return {
    api, queries, dialogs, navigations, layers, usageListeners, toasts, route, setRoute, setLocation, run, cleanup,
    page: () => page, modes: () => modes, unregistered: () => unregistered,
    emitUsage: () => { for (const callback of usageListeners) callback() },
    intervals, debounces,
    tick: () => { for (const run of [...intervals]) run() },
    settle: () => { for (const run of [...debounces]) run() },
  }
}
