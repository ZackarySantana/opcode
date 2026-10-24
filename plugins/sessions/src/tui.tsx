/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { ThemeSurface } from "@opcode/ui"
import type { Context } from "@opencode/plugin/tui/context"
import { createBrowser } from "./browser"
import { SessionsDialog } from "./dialog"
import { createInbox, inboxOptions, type Inbox } from "./inbox-host"
import { sessionsRemote } from "./rpc"
import { InboxSidebar, rowSummary } from "./sidebar"

/** Names already used by other commands are left alone; the first free one becomes the primary slash name. */
export function availableSlashNames(api: Pick<Context, "keymap" | "data" | "location">, candidates: readonly string[]) {
  const occupied = new Set(api.keymap.commands().flatMap((command) => command.slash ? [command.slash.name, ...(command.slash.aliases ?? [])] : []))
  for (const command of api.data.location.command.list(api.location) ?? []) occupied.add(command.name)
  return candidates.filter((name) => !occupied.has(name))
}

const slash = (names: readonly string[], extra?: { arguments: true }) => names[0] ? { slash: { name: names[0], aliases: names.slice(1), ...extra } } : {}

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
      else api.ui.toast.show({ variant: "warning", message: `No active session ${argument}. Use ${names[0] ? `/${names[0]}` : "Go to active session"} to list them.` })
    },
  }] }))
}

export default Plugin.define({
  id: "opcode-sessions",
  setup(api) {
    const location = api.location ?? api.data.location.default()
    // Both adapters use this exact connected client. Never read or upload a local index.
    const client = api.client
    const model = createBrowser(client, sessionsRemote(client, location.directory))
    const options = inboxOptions(api.options.inbox)
    // Disabled: no slot, no listeners, and the browser navigates without a back trail.
    const inbox = options && createInbox(api, options)
    // A dialog is not a route: the back trail records the session the browser was opened over.
    const open = inbox ? inbox.open : (sessionID: string) => api.ui.router.navigate({ type: "session", sessionID })
    const names = availableSlashNames(api, ["sessions", "sessions-all", "all-sessions"])
    let opened = false
    let unregisterSidebar = () => {}
    const dispose = () => {
      if (opened) api.ui.dialog.clear()
      unregisterSidebar()
      inbox?.dispose()
    }
    try {
      api.keymap.layer(() => ({ mode: "global", commands: [{
        id: "opcode-sessions.open", title: "All sessions", description: "Search recorded sessions across projects", group: "Session", palette: true,
        ...slash(names),
        run() {
          void model.activate()
          api.ui.dialog.show(() => <ThemeSurface name="dialog"><SessionsDialog model={model} open={open} /></ThemeSurface>, () => { opened = false })
          opened = true
          api.ui.dialog.set({ size: "large", centered: true })
        },
      }] }))
      if (inbox) {
        const go = availableSlashNames(api, ["go"])
        registerInboxCommands(api, inbox, go)
        // At the very top of the sidebar, above other plugins' sections.
        unregisterSidebar = api.ui.slot({ prepend: "sidebar.content", render: () => <InboxSidebar inbox={inbox} limit={options.rows} command={GO_COMMAND} pointer={go[0] && `/${go[0]}`} /> })
      }
    } catch (error) {
      dispose()
      void model.dispose()
      throw error
    }
    return async () => {
      dispose()
      await model.dispose()
    }
  },
})
