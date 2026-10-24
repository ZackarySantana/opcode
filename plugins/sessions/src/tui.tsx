/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createScreen, type Screen } from "@opcode/ui/screen"
import type { Context, Route } from "@opencode/plugin/tui/context"
import { createBrowser, type BrowserModel } from "./browser"
import { createInbox, inboxOptions, type Inbox } from "./inbox-host"
import { sessionsRemote } from "./rpc"
import { InboxSidebar, rowSummary } from "./sidebar"
import { BROWSER_MODE, BROWSER_ROUTE, SessionsView } from "./view"

const PLUGIN_ID = "opcode-sessions"

/** Names already used by other commands are left alone; the first free one becomes the primary slash name. */
export function availableSlashNames(api: Pick<Context, "keymap" | "data" | "location">, candidates: readonly string[]) {
  const occupied = new Set(api.keymap.commands().flatMap((command) => command.slash ? [command.slash.name, ...(command.slash.aliases ?? [])] : []))
  for (const command of api.data.location.command.list(api.location) ?? []) occupied.add(command.name)
  return candidates.filter((name) => !occupied.has(name))
}

const slash = (names: readonly string[], extra?: { arguments: true }) => names[0] ? { slash: { name: names[0], aliases: names.slice(1), ...extra } } : {}

export function registerBrowserCommands(api: Context, model: BrowserModel, screen: Screen, alive: () => boolean, open: (sessionID: string, from: Route) => void) {
  const names = availableSlashNames(api, ["sessions", "sessions-all", "all-sessions", "opcode-sessions"])
  const invalidate = screen.invalidate
  const active = () => alive() && screen.active()
  const invocation = () => {
    const current = screen.interaction()
    return () => alive() && current()
  }
  api.keymap.layer(() => ({ mode: "global", commands: [{
    id: "opcode-sessions.open", title: "All sessions", description: "Search recorded sessions across projects", group: "Session", palette: true,
    ...slash(names),
    run() {
      if (!alive()) return
      if (screen.owns()) return
      void model.activate()
      screen.open()
    },
  }] }))
  screen.commands(() => [
    { id: "opcode-sessions.close", title: "Back", bind: "escape", run() { if (active()) screen.close() } },
    { id: "opcode-sessions.up", title: "Previous session", bind: "up,k", run() { if (active()) model.move(-1) } },
    { id: "opcode-sessions.down", title: "Next session", bind: "down,j", run() { if (active()) model.move(1) } },
    { id: "opcode-sessions.clear", title: "Clear filters", bind: "x", run: async () => { if (active()) await model.clear() } },
    { id: "opcode-sessions.refresh", title: "Resynchronize sessions", bind: "r", run: async () => { if (active()) await model.refresh() } },
    { id: "opcode-sessions.subagents", title: "Toggle child sessions", bind: "s", run: async () => { if (active()) await model.filters({ showSubagents: !model.state().showSubagents }) } },
    { id: "opcode-sessions.search", title: "Search sessions", bind: "/", async run() {
      if (!active()) return
      const current = invocation()
      const query = await api.ui.dialog.prompt({ title: "Search sessions (regular expression)", value: model.state().query, placeholder: "title, directory, or message text; max 256 characters" })
      if (current() && query !== undefined) await model.filters({ query })
    } },
    { id: "opcode-sessions.project", title: "Filter project", bind: "p", async run() {
      if (!active()) return
      const current = invocation()
      const value = model.state()
      const project = await api.ui.dialog.select({ title: "Project", current: value.projectID ?? "", options: [
        { title: "All projects", value: "" }, ...value.projects.map((project) => ({ title: project.label, description: project.directory, value: project.id })),
      ] })
      if (current() && project !== undefined) await model.filters({ projectID: project || undefined })
    } },
    { id: "opcode-sessions.select", title: "Open session", bind: "enter,return", run() {
      if (!active()) return
      const value = model.state()
      const row = value.rows[value.selected]
      // Rows stay valid while a re-query runs; filter changes clear them first.
      if (!row) return
      invalidate()
      open(row.id, screen.previous())
    } },
  ])
  return invalidate
}

export const GO_COMMAND = "opcode-sessions.go"

/** `/go <n>` opens active session n, `/go back` returns, and plain `/go` (or the palette) lists them. */
export function registerInboxCommands(api: Context, inbox: Inbox, names: readonly string[]) {
  const list = async () => {
    const rows = inbox.rows()
    if (!rows.length) return api.ui.toast.show({ variant: "info", message: "No active sessions." })
    const sessionID = await api.ui.dialog.select({ title: "Active sessions", current: inbox.currentRoot(), options: rows.map((row, index) => ({
      title: `${index + 1}. ${row.title}`, description: rowSummary(row, row.id === inbox.currentRoot()), value: row.id,
    })) })
    if (sessionID) inbox.open(sessionID)
  }
  api.keymap.layer(() => ({ mode: "global", commands: [{
    id: GO_COMMAND, title: "Go to active session", description: "Open an active session by number, or go back", group: "Opcode", palette: true,
    ...slash(names, { arguments: true }),
    async run(input) {
      const argument = input?.trim() ?? ""
      if (!argument) return list()
      if (argument.toLowerCase() === "back") {
        if (!inbox.goBack()) api.ui.toast.show({ variant: "info", message: "Nothing to go back to." })
        return
      }
      const row = /^\d+$/.test(argument) ? inbox.rows()[Number(argument) - 1] : undefined
      if (row) inbox.open(row.id)
      else api.ui.toast.show({ variant: "warning", message: `No active session ${argument}. Use /${names[0] ?? "go"} to list them.` })
    },
  }] }))
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(api) {
    const location = api.location ?? api.data.location.default()
    // Both adapters use this exact connected client. Never read or upload a local index.
    const client = api.client
    const model = createBrowser(client, sessionsRemote(client, location.directory))
    const screen = createScreen(api, { id: PLUGIN_ID, name: BROWSER_ROUTE, mode: BROWSER_MODE })
    const options = inboxOptions(api.options.inbox)
    // Disabled: no slot, no listeners, and the browser navigates without a back trail.
    const inbox = options && createInbox(api, options)
    let active = true
    let invalidate = () => {}
    let unregisterSidebar = () => {}
    const unregister = api.ui.router.register({ name: BROWSER_ROUTE, render: () => <SessionsView model={model} screen={screen} currentSession={() => { const route = screen.previous(); return route.type === "session" ? route.sessionID : undefined }} /> })
    const dispose = () => {
      active = false
      invalidate()
      unregisterSidebar()
      inbox?.dispose()
      unregister()
    }
    try {
      invalidate = registerBrowserCommands(api, model, screen, () => active, inbox ? inbox.open : (sessionID) => api.ui.router.navigate({ type: "session", sessionID }))
      if (inbox) {
        const names = availableSlashNames(api, ["go", "opcode-go"])
        registerInboxCommands(api, inbox, names)
        // At the very top of the sidebar, above other plugins' sections.
        unregisterSidebar = api.ui.slot({ prepend: "sidebar.content", render: () => <InboxSidebar inbox={inbox} limit={options.rows} command={GO_COMMAND} pointer={names[0] && `/${names[0]}`} /> })
      }
    } catch (error) {
      dispose()
      void model.dispose()
      throw error
    }
    return async () => {
      dispose()
      screen.dispose()
      await model.dispose()
    }
  },
})
