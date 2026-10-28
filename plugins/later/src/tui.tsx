/** @jsxImportSource @opentui/solid */

import { ThemeSurface } from "@opcode/ui"
import { Plugin } from "@opencode/plugin/tui"
import { createRemote } from "./client"
import { LaterDialog } from "./dialog"
import { PLUGIN_ID } from "./domain"
import { LaterController } from "./host"
import { Sidebar } from "./sidebar"

export default Plugin.define({
  id: PLUGIN_ID,
  setup(api) {
    const remote = createRemote(() => api.client, () => api.location ?? api.data.location.default())
    const later = new LaterController(api, remote, (later) => <ThemeSurface name="dialog"><LaterDialog later={later} /></ThemeSurface>)
    // After the slot: below its appended sections, such as Pull requests. Later and Feed keep their config order.
    const unregisterSidebar = api.ui.slot({ after: "sidebar.content", render: () => <Sidebar later={later} /> })
    api.keymap.layer(() => ({ mode: "global", commands: [{
      id: `${PLUGIN_ID}.open`, title: "Later", group: "Opcode", palette: true,
      description: "Prompts saved to return to", slash: { name: "later" },
      run: () => later.open(),
    }] }))
    return () => {
      later.dispose()
      unregisterSidebar()
    }
  },
})
