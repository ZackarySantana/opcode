/** @jsxImportSource @opentui/solid */

import { ThemeSurface } from "@opcode/ui"
import { Plugin } from "@opencode/plugin/tui"
import { PREFIX, PullRequestsDialog } from "./dialog"
import { PullRequestsController, sendFeedback } from "./host"
import { Sidebar } from "./sidebar"
import { databasePath, SettingsDatabase } from "./sqlite"

export default Plugin.define({
  id: PREFIX,
  setup(api) {
    const database = new SettingsDatabase(databasePath(api.options.database))
    const prs = new PullRequestsController(database)
    const unregisterSidebar = api.ui.slot({ append: "sidebar.content", render: () => <Sidebar prs={prs} /> })
    const unloaded = new AbortController()
    const prompt = typeof api.options.commentsPrompt === "string" ? api.options.commentsPrompt : undefined
    let opened = false
    let sending = false
    api.keymap.layer(() => ({ mode: "global", commands: [{
      id: `${PREFIX}.open`, title: "Pull requests", group: "Opcode", palette: true,
      description: "Your GitHub pull requests and review requests", slash: { name: "ghpr" },
      run() {
        api.ui.dialog.show(() => <ThemeSurface name="dialog"><PullRequestsDialog prs={prs} /></ThemeSurface>, () => { opened = false })
        opened = true
        api.ui.dialog.set({ size: "large", centered: true })
      },
    }, {
      id: `${PREFIX}.comments`, title: "Send PR review comments", group: "Opcode", palette: true,
      description: "Ask the agent to act on review comments on this branch's pull request", slash: { name: "ghpr-comments" },
      run() {
        if (sending) return
        sending = true
        void sendFeedback(api, unloaded.signal, prompt).finally(() => { sending = false })
      },
    }] }))
    prs.start()
    return () => {
      unloaded.abort()
      if (opened) api.ui.dialog.clear()
      try { unregisterSidebar() } finally {
        prs.dispose()
        database.close()
      }
    }
  },
})
