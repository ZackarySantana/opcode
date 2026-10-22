/** @jsxImportSource @opentui/solid */

import { ThemeSurface } from "@opcode/ui"
import { Plugin } from "@opencode/plugin/tui"
import { FeedsController } from "./host"
import { databasePath, FeedsDatabase } from "./sqlite"
import { FeedDialog } from "./dialog"
import { Sidebar } from "./sidebar"

export default Plugin.define({
  id: "opcode-feed",
  setup(api) {
    const database = new FeedsDatabase(databasePath(api.options.database))
    const feeds = new FeedsController(database)
    const unregisterSidebar = api.ui.slot({ append: "sidebar.content", render: () => <Sidebar feeds={feeds} /> })
    let opened = false
    api.keymap.layer(() => ({ mode: "global", commands: [{
      id: "opcode-feed.open", title: "Feeds", group: "Opcode", palette: true,
      description: "Timeline of subscribed status pages and feeds", slash: { name: "feed" },
      run() {
        api.ui.dialog.show(() => <ThemeSurface name="dialog"><FeedDialog feeds={feeds} /></ThemeSurface>, () => { opened = false })
        opened = true
        api.ui.dialog.set({ size: "large", centered: true })
      },
    }, {
      id: "opcode-feed.refresh-all", title: "Refresh feeds", group: "Opcode", palette: true,
      description: "Fetch every subscribed feed now", slash: { name: "feed-refresh" },
      run() {
        const count = feeds.subscriptions().length
        api.ui.toast.show(count
          ? { title: "Feed", message: `Refreshing ${count} ${count === 1 ? "feed" : "feeds"}.`, variant: "info" }
          : { title: "Feed", message: "No feeds yet. Subscribe to one in /feed.", variant: "warning" })
        void feeds.refreshAll()
      },
    }] }))
    feeds.start()
    return () => {
      if (opened) api.ui.dialog.clear()
      try { unregisterSidebar() } finally {
        feeds.dispose()
        database.close()
      }
    }
  },
})
