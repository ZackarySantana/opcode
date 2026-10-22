import { expect, test } from "bun:test"
import type { Context, Destination, KeymapLayer, Route, ToastOptions } from "@opencode/plugin/tui/context"
import { createRoot, createSignal } from "solid-js"
import { createScreen } from "@opcode/ui/screen"
import { createBrowser } from "../src/browser"
import { availableSlashNames, registerBrowserCommands } from "../src/tui"
import type { SessionResult } from "../src/domain"
import { record, remoteStub } from "./fixtures"
import { BROWSER_ROUTE } from "../src/view"

function fixture() {
  const searchGate: { current?: Promise<void> } = {}
  const rows: SessionResult[] = ["s1", "s2"].map((id) => ({ ...record(id), directory: id === "s1" ? "/work/alpha" : "/work/sam's app", snippet: "", messageCount: 0, modelCount: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }))
  const model = createBrowser({ session: { list: async () => ({ data: [], cursor: {} }) }, message: { list: async () => ({ data: [], cursor: {} }) } }, remoteStub({ search: async () => { await searchGate.current; return { rows, projects: [], truncated: false } } }))
  const [route, setRoute] = createSignal<Route>({ type: "session", sessionID: "origin" })
  const layers: KeymapLayer[] = []
  const copied: string[] = []
  const toasts: ToastOptions[] = []
  const replies = { confirm: true, copy: true, query: undefined as string | undefined, project: undefined as string | undefined }
  const dialogs = { confirm: async () => replies.confirm, prompt: async () => replies.query, select: async () => replies.project }
  const api = {
    location: { directory: "/work/alpha" },
    data: { location: { command: { list: () => [] } } },
    keymap: { layer: (factory: () => KeymapLayer) => layers.push(factory()), commands: () => [] },
    renderer: { copyToClipboardOSC52: (text: string) => { copied.push(text); return replies.copy } },
    ui: {
      router: { current: route, navigate: (next: Destination) => { setRoute(next.type === "plugin" && !("id" in next) ? { ...next, id: "opcode-sessions" } : next as Route) } },
      dialog: dialogs,
      toast: { show: (toast: ToastOptions) => toasts.push(toast) },
    },
  } as unknown as Context
  const dispose = createRoot((dispose) => {
    const screen = createScreen(api, { id: "opcode-sessions", name: BROWSER_ROUTE, mode: BROWSER_ROUTE })
    registerBrowserCommands(api, model, screen, () => true)
    return dispose
  })
  return { api, model, searchGate, replies, dialogs, copied, toasts, layers, route,
    run: async (name: string) => { await layers.flatMap((layer) => layer.commands ?? []).find((command) => command.id === `opcode-sessions.${name}`)!.run() },
    async [Symbol.asyncDispose]() { dispose(); await model.dispose() },
  }
}

test("browser preserves return route, cancellation, local opening, and confirmed OSC52 copying", async () => {
  await using ui = fixture()
  await ui.run("open"); await ui.model.load()
  await ui.run("open")
  await ui.run("close")
  expect(ui.route()).toEqual({ type: "session", sessionID: "origin" })
  await ui.run("open"); await ui.model.load()
  await ui.run("down")
  ui.replies.confirm = false
  await ui.run("select")
  expect(ui.copied).toEqual([])
  ui.replies.confirm = true
  await ui.run("select")
  expect(ui.copied).toEqual(["opencode '/work/sam'\\''s app' --session 's2'"])
  expect(ui.toasts[0]?.variant).toBe("success")
  ui.replies.copy = false
  await ui.run("select")
  expect(ui.toasts[1]?.variant).toBe("error")
  await ui.run("up")
  await ui.run("select")
  expect(ui.route()).toEqual({ type: "session", sessionID: "s1" })
  await ui.run("open"); await ui.model.load()
  await ui.model.filters({ query: "keep" })
  await ui.run("search")
  expect(ui.model.state().query).toBe("keep")
})

test("enter opens the selected row while a background re-query is in flight", async () => {
  await using ui = fixture()
  await ui.run("open"); await ui.model.load()
  const gate = Promise.withResolvers<void>()
  ui.searchGate.current = gate.promise
  const reload = ui.model.load() // As the open browser's periodic re-query does.
  expect(ui.model.state().loading).toBe(true)
  await ui.run("select")
  expect(ui.route()).toEqual({ type: "session", sessionID: "s1" })
  gate.resolve(); await reload
})

test("pending search and project dialogs cannot mutate a later browser activation", async () => {
  await using ui = fixture()
  await ui.run("open"); await ui.model.load()
  const query = Promise.withResolvers<string | undefined>()
  ui.dialogs.prompt = () => query.promise
  const searching = ui.run("search")
  await ui.run("close")
  await ui.run("open"); await ui.model.load()
  query.resolve("old activation")
  await searching
  expect(ui.model.state().query).toBe("")

  const project = Promise.withResolvers<string | undefined>()
  ui.dialogs.select = () => project.promise
  const filtering = ui.run("project")
  await ui.run("close")
  await ui.run("open"); await ui.model.load()
  project.resolve("old-project")
  await filtering
  expect(ui.model.state().projectID).toBeUndefined()
})

test("leaving the route invalidates confirmation and a newer dialog supersedes an older one", async () => {
  await using ui = fixture()
  await ui.run("open"); await ui.model.load()
  const query = Promise.withResolvers<string | undefined>()
  ui.dialogs.prompt = () => query.promise
  const oldSearch = ui.run("search")
  ui.dialogs.prompt = async () => "latest invocation"
  await ui.run("search")
  query.resolve("stale invocation")
  await oldSearch
  expect(ui.model.state().query).toBe("latest invocation")

  await ui.run("down")
  const confirmed = Promise.withResolvers<boolean>()
  ui.dialogs.confirm = () => confirmed.promise
  const copying = ui.run("select")
  const browser = ui.route()
  ui.api.ui.router.navigate({ type: "home" })
  // Even leaving and returning externally must not revive the pending confirmation.
  ui.api.ui.router.navigate(browser)
  confirmed.resolve(true)
  await copying
  expect(ui.copied).toEqual([])
  expect(ui.toasts).toEqual([])
})

test("a different plugin's same-name route never suppresses opening or steals the return route", async () => {
  await using ui = fixture()
  const foreign: Route = { type: "plugin", id: "another-plugin", name: BROWSER_ROUTE }
  ui.api.ui.router.navigate(foreign)
  await ui.run("open"); await ui.model.load()
  expect(ui.route()).toEqual({ type: "plugin", id: "opcode-sessions", name: BROWSER_ROUTE })
  await ui.run("close")
  expect(ui.route()).toEqual(foreign)
})

test("slash commands retain original names only when unoccupied", async () => {
  await using ui = fixture()
  expect(ui.layers[0]?.commands?.[0]?.slash).toEqual({ name: "sessions", aliases: ["sessions-all", "all-sessions", "opcode-sessions"] })
  const api = { ...ui.api, keymap: { ...ui.api.keymap, commands: () => [{ slash: { name: "sessions", aliases: ["sessions-all"] }, run() {} }] } } as Context
  expect(availableSlashNames(api)).toEqual(["all-sessions", "opcode-sessions"])
})
