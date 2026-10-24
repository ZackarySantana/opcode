import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { KeymapLayer, Route } from "@opencode/plugin/tui/context"
import tuiPlugin from "../src/tui.js"
import { parseRoute, PLUGIN_ID, ROUTE } from "../src/navigation.js"
import { createTuiHarness, dashboard } from "./tui-harness.js"

test("route parsing owns filters only; return navigation is not serialized into filter state", () => {
  expect(parseRoute({ range: "bad", back: { type: "session" } })).toEqual({ range: "30d", projectID: undefined, model: undefined, tab: "cost" })
  expect(parseRoute({ range: "7d", projectID: "p", model: "m", back: { type: "plugin", id: "other", name: "other.page", data: { tab: 1 } } })).toMatchObject({
    range: "7d", projectID: "p", model: "m",
  })
  expect(parseRoute({ back: { type: "plugin", id: PLUGIN_ID, name: ROUTE } })).not.toHaveProperty("back")
})

test("project picker shows server paths beside project names while selecting by ID", async () => {
  const harness = await createTuiHarness()
  try {
    await harness.run("open")
    const pending = harness.run("project")
    const data = dashboard()
    data.projectOptions = [
      { id: "opaque-project-a", label: "main", directory: "/remote/a/main" },
      { id: "opaque-project-b", label: "main", directory: "/remote/b/main" },
    ]
    harness.queries.at(-1)!.resolve(data)
    await Bun.sleep(0)
    const selection = harness.dialogs.at(-1)!
    expect(selection.options.options).toEqual([
      { title: "All projects", value: "" },
      { title: "main", value: "opaque-project-a", description: "/remote/a/main" },
      { title: "main", value: "opaque-project-b", description: "/remote/b/main" },
    ])
    selection.resolve("opaque-project-b")
    await pending
    expect(harness.route()).toMatchObject({ data: { range: "30d", projectID: "opaque-project-b" } })
  } finally { await harness.cleanup() }
})

test("a same-name route owned by another plugin is neither operated on nor closed on unload", async () => {
  const foreign: Route = { type: "plugin", id: "other", name: ROUTE, data: { range: "all", back: { type: "session", sessionID: "not-ours" } } }
  const harness = await createTuiHarness(foreign)
  try {
    for (const id of ["close", "reset", "date", "project", "model", "refresh"]) await harness.run(id)
    expect(harness.queries).toHaveLength(0)
    expect(harness.dialogs).toHaveLength(0)
    expect(harness.navigations).toHaveLength(0)
    await harness.run("open")
    expect(harness.route()).toMatchObject({ id: PLUGIN_ID, name: ROUTE, data: { range: "30d" } })
    const opened = harness.route()
    expect(opened.type === "plugin" && opened.data).not.toHaveProperty("back")
    await harness.run("close")
    expect(harness.route()).toEqual(foreign)
    const navigations = harness.navigations.length
    await harness.cleanup()
    expect(harness.navigations).toHaveLength(navigations)
    expect(harness.route()).toEqual(foreign)
  } finally { await harness.cleanup() }
})

for (const origin of [
  { type: "session", sessionID: "original-session" },
  { type: "plugin", id: "other", name: "other.page", data: { tab: 2 } },
] satisfies Route[]) {
  test(`filtered/reopened cost screen snapshots its live-store ${origin.type} return route`, async () => {
    const harness = await createTuiHarness(origin, true)
    try {
      const live = harness.route()
      await harness.run("open")
      expect(harness.route()).toBe(live)
      expect(live).toMatchObject({ type: "plugin", id: PLUGIN_ID, name: ROUTE })
      const selection = harness.run("date")
      harness.dialogs.at(-1)!.resolve("7d")
      await selection
      await harness.run("open")
      await harness.run("reset")
      await harness.cleanup()
      expect(harness.route()).toEqual(origin)
      expect(harness.unregistered()).toBe(true)
    } finally { await harness.cleanup() }
  })
}

for (const id of ["date", "project", "model"] as const) {
  const value = { date: "7d", project: "p", model: "provider/model" }[id]
  test(`${id} selector cannot reopen a departed route or affect a later activation`, async () => {
    const harness = await createTuiHarness()
    try {
      for (const reenter of [false, true]) {
        await harness.run("open")
        const pending = harness.run(id)
        if (id !== "date") harness.queries.at(-1)!.resolve(dashboard())
        await Bun.sleep(0)
        const selection = harness.dialogs.at(-1)!
        expect(selection.options.title).toBe({ date: "Date range", project: "Project", model: "Model" }[id])
        harness.setRoute({ type: "home" })
        if (reenter) await harness.run("open")
        const destination = harness.route()
        selection.resolve(value)
        await pending
        expect(harness.route()).toEqual(destination)
      }
    } finally { await harness.cleanup() }
  })

  test(`an older ${id} selection cannot overwrite a newer filter`, async () => {
    const harness = await createTuiHarness()
    try {
      await harness.run("open")
      const older = harness.run(id)
      if (id !== "date") harness.queries.at(-1)!.resolve(dashboard())
      await Bun.sleep(0)
      const oldDialog = harness.dialogs.at(-1)!
      const newer = harness.run("date")
      harness.dialogs.at(-1)!.resolve("all")
      await newer
      oldDialog.resolve(value)
      await older
      expect(harness.route()).toMatchObject({ data: { range: "all" } })
      const route = harness.route()
      expect(route.type === "plugin" && route.data?.projectID).toBeUndefined()
      expect(route.type === "plugin" && route.data?.model).toBeUndefined()
    } finally { await harness.cleanup() }
  })
}

for (const id of ["project", "model"] as const) {
  test(`a pending ${id} RPC cannot open a selector after leaving or unloading`, async () => {
    for (const unload of [false, true]) {
      const harness = await createTuiHarness()
      try {
        await harness.run("open")
        const pending = harness.run(id)
        const request = harness.queries.at(-1)!
        if (unload) await harness.cleanup()
        else harness.setRoute({ type: "home" })
        request.resolve(dashboard())
        await pending
        expect(request.signal.aborted).toBe(true)
        expect(harness.dialogs).toHaveLength(0)
        expect(harness.route()).toEqual({ type: "home" })
        expect(harness.toasts).toHaveLength(0)
      } finally { await harness.cleanup() }
    }
  })

  test(`a pending ${id} RPC is superseded before a newer selector completes`, async () => {
    const harness = await createTuiHarness()
    try {
      await harness.run("open")
      const older = harness.run(id)
      const request = harness.queries.at(-1)!
      const newer = harness.run("date")
      harness.dialogs.at(-1)!.resolve("7d")
      await newer
      request.resolve(dashboard())
      await older
      expect(harness.dialogs).toHaveLength(1)
      expect(harness.route()).toMatchObject({ data: { range: "7d" } })
      expect(request.signal.aborted).toBe(true)
    } finally { await harness.cleanup() }
  })

  for (const change of ["filters", "location"] as const) {
    test(`changing ${change} aborts the pending ${id} RPC and prevents an orphan selector`, async () => {
      const harness = await createTuiHarness()
      try {
        await harness.run("open")
        const pending = harness.run(id)
        const request = harness.queries.at(-1)!
        if (change === "location") harness.setLocation({ directory: "/another/project" })
        else harness.setRoute({ type: "plugin", id: PLUGIN_ID, name: ROUTE, data: { range: "all" } })
        expect(request.signal.aborted).toBe(true)
        const destination = harness.route()
        request.resolve(dashboard())
        await pending
        expect(harness.dialogs).toHaveLength(0)
        expect(harness.route()).toEqual(destination)
        expect(harness.toasts).toHaveLength(0)
      } finally { await harness.cleanup() }
    })
  }
}

test("TUI commands preserve return navigation; refresh rescans; unload cancels imports and unregisters", async () => {
  const layers: KeymapLayer[] = []
  let current: Route = { type: "session", sessionID: "session-a" }
  let unregistered = false
  let signal!: AbortSignal
  let imports = 0
  let selection: string | undefined
  const api = {
    location: { directory: "/remote/project" },
    client: {
      rpc: () => ({
        status: async (_input: unknown, options: { signal: AbortSignal }) => { signal = options.signal; imports++; return { projectID: "p", directory: "/remote/project", lastImport: 1 } },
        completeImport: async () => ({}), dashboard: async () => ({ projectOptions: [], modelOptions: [] }),
      }),
      session: { list: async () => ({ data: [], cursor: {} }) },
    },
    keymap: { layer: (factory: () => KeymapLayer) => { layers.push(factory()) } },
    ui: {
      router: {
        current: () => current,
        register: () => () => { unregistered = true },
        navigate: (route: Route) => { current = { ...route, ...(route.type === "plugin" ? { id: "opcode-cost" } : {}) } as Route },
      },
      dialog: { clear: () => undefined, select: async () => selection },
      toast: { show: ({ message }: { message: string }) => { throw new Error(message) } },
    },
  }
  const root = createRoot((dispose) => ({ dispose, cleanup: tuiPlugin.setup(api as never) }))
  const cleanup = await root.cleanup
  if (!cleanup) throw new Error("Missing cleanup")
  const commands = layers.flatMap((layer) => layer.commands ?? [])
  const run = async (id: string) => { await commands.find((command) => command.id === `opcode-cost.${id}`)!.run() }
  try {
    await run("open")
    await run("open")
    expect(current).toMatchObject({ type: "plugin", name: ROUTE, data: { range: "30d" } })
    expect(current).not.toHaveProperty("data.back")
    selection = "7d"
    await run("date")
    expect(current).toMatchObject({ data: { range: "7d" } })
    selection = undefined
    await run("date")
    expect(current).toMatchObject({ data: { range: "7d" } })
    await run("reset")
    expect(current).toMatchObject({ data: { range: "30d" } })
    await run("refresh")
    const before = imports
    await run("refresh")
    expect(imports).toBe(before + 1)
    expect(new Set(commands.flatMap((command) => command.bind ? [command.bind] : []))).toEqual(new Set(["escape", "d", "p", "m", "x", "r", "tab,shift+tab"]))
    await run("close")
    expect(current).toEqual({ type: "session", sessionID: "session-a" })
  } finally { root.dispose(); await cleanup() }
  expect(signal.aborted).toBe(true)
  expect(unregistered).toBe(true)
})
