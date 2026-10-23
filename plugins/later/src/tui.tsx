/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { LaterController, MANAGER_ROUTE } from "./host"
import { databasePath, LaterDatabase } from "./sqlite"
import { Manager, Sidebar } from "./view"

export default Plugin.define({
  id: "opcode-later",
  setup(api) {
    const database = new LaterDatabase(databasePath(api.options.database))
    let controller: LaterController | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    let unregisterRoute: (() => void) | undefined
    let unregisterSidebar: (() => void) | undefined
    let disposed = false
    const cleanup = () => {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      try { controller?.dispose() } finally {
        try { unregisterSidebar?.() } finally {
          try { unregisterRoute?.() } finally { database.close() }
        }
      }
    }
    try {
      const [version, update] = createSignal(0)
      const host = new LaterController(api, database, () => update((value) => value + 1))
      controller = host
      const view = () => { version(); return host.model.view() }
      unregisterRoute = api.ui.router.register({ name: MANAGER_ROUTE, render: () => <Manager view={view} screen={host.screen} /> })
      // After the slot: below its appended sections, such as Pull requests. Later and Feed keep their config order.
      unregisterSidebar = api.ui.slot({ after: "sidebar.content", render: () => <Sidebar view={view} /> })
      api.keymap.layer(() => ({
        mode: "global",
        commands: [{ ...host.command("open", "Later"), description: "Manage the client-local Later list", group: "Plugin", palette: true, slash: { name: "later" } }],
      }))
      host.screen.commands(() => [
        host.command("close", "Back", "escape"),
        host.command("add", "Add", "a"),
        host.command("edit", "Edit", "e"),
        host.command("complete", "Complete or restore", "space"),
        host.command("paste", "Paste and complete (without submitting)", "return"),
        host.command("delete", "Delete permanently", "d"),
        host.command("up", "Previous item", "up,k"),
        host.command("down", "Next item", "down,j"),
        host.command("moveUp", "Move up", "shift+k"),
        host.command("moveDown", "Move down", "shift+j"),
        host.command("history", "Toggle completed history", "h"),
        host.command("refresh", "Refresh", "r"),
      ])
      timer = setInterval(() => host.poll(), 350)
      return cleanup
    } catch (error) {
      cleanup()
      throw error
    }
  },
})
