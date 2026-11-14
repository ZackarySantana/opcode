/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { ThemeSurface } from "@opcode/ui"
import type { Context } from "@opencode/plugin/tui/context"
import { createBrowser } from "./browser"
import { SessionsDialog } from "./dialog"
import { sessionsRemote } from "./rpc"

/** Names already used by other commands are left alone; the first free one becomes the primary slash name. */
export function availableSlashNames(api: Pick<Context, "keymap" | "data" | "location">, candidates: readonly string[]) {
  const occupied = new Set(api.keymap.commands().flatMap((command) => command.slash ? [command.slash.name, ...(command.slash.aliases ?? [])] : []))
  for (const command of api.data.location.command.list(api.location) ?? []) occupied.add(command.name)
  return candidates.filter((name) => !occupied.has(name))
}

export default Plugin.define({
  id: "opcode-sessions",
  setup(api) {
    const location = api.location ?? api.data.location.default()
    // The browser uses this exact connected client. Never read or upload a local index.
    const model = createBrowser(api.client, sessionsRemote(api.client, location.directory))
    const open = (sessionID: string) => api.ui.router.navigate({ type: "session", sessionID })
    const [name, ...aliases] = availableSlashNames(api, ["sessions", "sessions-all", "all-sessions"])
    let opened = false
    api.keymap.layer(() => ({ mode: "global", commands: [{
      id: "opcode-sessions.open", title: "All sessions", description: "Search recorded sessions across projects", group: "Session", palette: true,
      ...name ? { slash: { name, aliases } } : {},
      run() {
        void model.activate()
        api.ui.dialog.show(() => <ThemeSurface name="dialog"><SessionsDialog model={model} open={open} /></ThemeSurface>, () => { opened = false })
        opened = true
        api.ui.dialog.set({ size: "xlarge", centered: true })
      },
    }] }))
    return async () => {
      if (opened) api.ui.dialog.clear()
      await model.dispose()
    }
  },
})
