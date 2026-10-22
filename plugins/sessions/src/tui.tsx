/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createScreen, type Screen } from "@opcode/ui/screen"
import type { Context } from "@opencode/plugin/tui/context"
import { createBrowser, type BrowserModel } from "./browser"
import { resumeCommand } from "./domain"
import { sessionsRemote } from "./rpc"
import { BROWSER_MODE, BROWSER_ROUTE, SessionsView } from "./view"

const PLUGIN_ID = "opcode-sessions"

export function availableSlashNames(api: Pick<Context, "keymap" | "data" | "location">) {
  const occupied = new Set(api.keymap.commands().flatMap((command) => command.slash ? [command.slash.name, ...(command.slash.aliases ?? [])] : []))
  for (const command of api.data.location.command.list(api.location) ?? []) occupied.add(command.name)
  return ["sessions", "sessions-all", "all-sessions", "opcode-sessions"].filter((name) => !occupied.has(name))
}

export function registerBrowserCommands(api: Context, model: BrowserModel, screen: Screen, alive: () => boolean) {
  const names = availableSlashNames(api)
  const invalidate = screen.invalidate
  const active = () => alive() && screen.active()
  const invocation = () => {
    const current = screen.interaction()
    return () => alive() && current()
  }
  api.keymap.layer(() => ({ mode: "global", commands: [{
    id: "opcode-sessions.open", title: "All sessions", description: "Search recorded sessions across projects", group: "Session", palette: true,
    ...(names[0] ? { slash: { name: names[0], aliases: names.slice(1) } } : {}),
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
    { id: "opcode-sessions.select", title: "Open session", bind: "enter,return", async run() {
      if (!active()) return
      const value = model.state()
      const row = value.rows[value.selected]
      // Rows stay valid while a re-query runs; filter changes clear them first.
      if (!row) return
      const location = api.location ?? api.data.location.default()
      if (row.directory === location.directory) { invalidate(); api.ui.router.navigate({ type: "session", sessionID: row.id }); return }
      const current = invocation()
      const confirmed = await api.ui.dialog.confirm({ title: "Copy session start command?", message: "Run this POSIX-shell command in a new terminal connected to the same OpenCode server. Remote paths belong to that server." })
      if (!current() || !confirmed) return
      const copied = api.renderer.copyToClipboardOSC52(resumeCommand(row.directory, row.id))
      api.ui.toast.show({ variant: copied ? "success" : "error", message: copied ? "Session command copied. Use the same server connection." : "Your terminal could not copy the session command." })
    } },
  ])
  return invalidate
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(api) {
    const location = api.location ?? api.data.location.default()
    // Both adapters use this exact connected client. Never read or upload a local index.
    const client = api.client
    const model = createBrowser(client, sessionsRemote(client, location.directory))
    const screen = createScreen(api, { id: PLUGIN_ID, name: BROWSER_ROUTE, mode: BROWSER_MODE })
    let active = true
    let invalidate = () => {}
    const unregister = api.ui.router.register({ name: BROWSER_ROUTE, render: () => <SessionsView model={model} screen={screen} currentSession={() => { const route = screen.previous(); return route.type === "session" ? route.sessionID : undefined }} /> })
    try { invalidate = registerBrowserCommands(api, model, screen, () => active) } catch (error) {
      active = false
      invalidate()
      unregister()
      void model.dispose()
      throw error
    }
    return async () => {
      active = false
      invalidate()
      screen.dispose()
      unregister()
      await model.dispose()
    }
  },
})
