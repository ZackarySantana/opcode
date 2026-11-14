/** @jsxImportSource @opentui/solid */

import { ThemeSurface } from "@opcode/ui"
import { Plugin } from "@opencode/plugin/tui"
import { createRemote, PullRequestsClient } from "./client"
import { PullRequestsDialog } from "./dialog"
import { PLUGIN_ID } from "./model"
import { Sidebar } from "./sidebar"

export default Plugin.define({
  id: PLUGIN_ID,
  setup(api) {
    const remote = createRemote(() => api.client, () => api.location ?? api.data.location.default())
    const prs = new PullRequestsClient(remote)
    const unregisterSidebar = api.ui.slot({ append: "sidebar.content", render: () => <Sidebar prs={prs} /> })
    let opened = false
    api.keymap.layer(() => ({ mode: "global", commands: [{
      id: `${PLUGIN_ID}.open`, title: "Pull requests", group: "Opcode", palette: true,
      description: "Your GitHub pull requests and review requests", slash: { name: "ghpr" },
      run() {
        api.ui.dialog.show(() => <ThemeSurface name="dialog"><PullRequestsDialog prs={prs} /></ThemeSurface>, () => { opened = false })
        opened = true
        api.ui.dialog.set({ size: "large", centered: true })
      },
    }] }))
    prs.start()
    return () => {
      if (opened) api.ui.dialog.clear()
      try { unregisterSidebar() } finally { prs.dispose() }
    }
  },
})
