/** @jsxImportSource @opentui/solid */

import { ThemeSurface } from "@opcode/ui"
import { Plugin } from "@opencode/plugin/tui"
import { LaterDialog } from "./dialog"
import { LaterController, PREFIX } from "./host"
import { Sidebar } from "./sidebar"
import { databasePath, LaterDatabase } from "./sqlite"

export default Plugin.define({
  id: PREFIX,
  setup(api) {
    const database = new LaterDatabase(databasePath(api.options.database))
    let later: LaterController
    try {
      later = new LaterController(api, database, (later) => <ThemeSurface name="dialog"><LaterDialog later={later} /></ThemeSurface>)
    } catch (error) {
      database.close()
      throw error
    }
    // After the slot: below its appended sections, such as Pull requests. Later and Feed keep their config order.
    const unregisterSidebar = api.ui.slot({ after: "sidebar.content", render: () => <Sidebar later={later} /> })
    api.keymap.layer(() => ({ mode: "global", commands: [{
      id: `${PREFIX}.open`, title: "Later", group: "Opcode", palette: true,
      description: "Prompts saved to return to", slash: { name: "later" },
      run: () => later.open(),
    }] }))
    const timer = setInterval(() => later.poll(), 350)
    return () => {
      clearInterval(timer)
      later.dispose()
      try { unregisterSidebar() } finally { database.close() }
    }
  },
})
