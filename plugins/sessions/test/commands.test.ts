import { expect, test } from "bun:test"
import type { Context, Destination, KeymapLayer, Route } from "@opencode/plugin/tui/context"
import { createRoot, createSignal } from "solid-js"
import { createScreen } from "@opcode/ui/screen"
import { createBrowser } from "../src/browser"
import { availableSlashNames, registerBrowserCommands, registerInboxCommands } from "../src/tui"
import type { Inbox } from "../src/inbox-host"
import type { SessionResult } from "../src/domain"
import { record, remoteStub } from "./fixtures"
import { BROWSER_ROUTE } from "../src/view"

function fixture() {
  const searchGate: { current?: Promise<void> } = {}
  const rows: SessionResult[] = ["s1", "s2"].map((id) => ({ ...record(id), directory: id === "s1" ? "/work/alpha" : "/work/sam's app", snippet: "", messageCount: 0, modelCount: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }))
  const model = createBrowser({ session: { list: async () => ({ data: [], cursor: {} }) }, message: { list: async () => ({ data: [], cursor: {} }) } }, remoteStub({ search: async () => { await searchGate.current; return { rows, projects: [], truncated: false } } }))
  const [route, setRoute] = createSignal<Route>({ type: "session", sessionID: "origin" })
  const layers: KeymapLayer[] = []
  const opened: Array<{ sessionID: string; from: Route }> = []
  const replies = { query: undefined as string | undefined, project: undefined as string | undefined }
  const dialogs = { prompt: async () => replies.query, select: async () => replies.project }
  const api = {
    location: { directory: "/work/alpha" },
    data: { location: { command: { list: () => [] } } },
    keymap: { layer: (factory: () => KeymapLayer) => layers.push(factory()), commands: () => [] },
    ui: {
      router: { current: route, navigate: (next: Destination) => { setRoute(next.type === "plugin" && !("id" in next) ? { ...next, id: "opcode-sessions" } : next as Route) } },
      dialog: dialogs,
    },
  } as unknown as Context
  const dispose = createRoot((dispose) => {
    const screen = createScreen(api, { id: "opcode-sessions", name: BROWSER_ROUTE, mode: BROWSER_ROUTE })
    registerBrowserCommands(api, model, screen, () => true, (sessionID, from) => { opened.push({ sessionID, from }); api.ui.router.navigate({ type: "session", sessionID }) })
    return dispose
  })
  return { api, model, searchGate, replies, dialogs, opened, layers, route,
    run: async (name: string) => { await layers.flatMap((layer) => layer.commands ?? []).find((command) => command.id === `opcode-sessions.${name}`)!.run() },
    async [Symbol.asyncDispose]() { dispose(); await model.dispose() },
  }
}

test("browser preserves return route and opens a session in any directory from the session it was opened over", async () => {
  await using ui = fixture()
  await ui.run("open"); await ui.model.load()
  await ui.run("open")
  await ui.run("close")
  expect(ui.route()).toEqual({ type: "session", sessionID: "origin" })
  await ui.run("open"); await ui.model.load()
  await ui.run("down")
  await ui.run("select")
  expect(ui.route()).toEqual({ type: "session", sessionID: "s2" })
  expect(ui.opened).toEqual([{ sessionID: "s2", from: { type: "session", sessionID: "origin" } }])
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

test("a newer dialog supersedes an older one", async () => {
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
  expect(availableSlashNames(api, ["sessions", "sessions-all", "all-sessions"])).toEqual(["all-sessions"])
})

test("/go opens the sidebar's numbered row, goes back, lists without a number, and rejects other input", async () => {
  const opened: string[] = []
  const toasts: string[] = []
  const layers: KeymapLayer[] = []
  let wentBack = 0
  let listed = 0
  const inbox = {
    rows: () => [{ id: "first", state: "working", agents: 0, since: 0, title: "First", directory: "/a" }, { id: "second", state: "finished", agents: 0, since: 0, title: "Second", directory: "/b" }],
    currentRoot: () => undefined, open: (id: string) => opened.push(id), goBack: () => { wentBack++; return true },
  } as unknown as Inbox
  const api = {
    keymap: { layer: (factory: () => KeymapLayer) => layers.push(factory()) },
    ui: { toast: { show: (toast: { message: string }) => toasts.push(toast.message) }, dialog: { select: async () => { listed++; return "first" } } },
  } as unknown as Context
  registerInboxCommands(api, inbox, ["go"])
  const go = layers[0]!.commands![0]!
  expect(go.slash).toEqual({ name: "go", aliases: [], arguments: true })
  await go.run("2")
  await go.run(" Back ")
  await go.run("")
  await go.run("3")
  expect(opened).toEqual(["second", "first"])
  expect(wentBack).toBe(1)
  expect(listed).toBe(1)
  expect(toasts).toEqual(["No active session 3. Use /go to list them."])
})
