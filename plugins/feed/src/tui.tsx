/** @jsxImportSource @opentui/solid */

import { ThemeSurface } from "@opcode/ui"
import { Plugin } from "@opencode/plugin/tui"
import { FeedsController } from "./host"
import { databasePath, FeedsDatabase } from "./sqlite"
import { FeedDialog } from "./dialog"
import { Sidebar } from "./sidebar"

const DEFAULT_INTERVAL_MINUTES = 10

export default Plugin.define({
  id: "opcode-feed",
  setup(api) {
    const database = new FeedsDatabase(databasePath(api.options.database))
    const feeds = new FeedsController(database)
    const minutes = typeof api.options.interval === "number" && api.options.interval > 0 ? api.options.interval : DEFAULT_INTERVAL_MINUTES
    const timer = setInterval(() => void feeds.refreshAll(), minutes * 60_000)
    const clock = setInterval(() => feeds.tick(), 60_000)
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
    }] }))
    void feeds.refreshAll()
    return () => {
      clearInterval(timer)
      clearInterval(clock)
      if (opened) api.ui.dialog.clear()
      try { unregisterSidebar() } finally {
        feeds.dispose()
        database.close()
      }
    }
  },
})
