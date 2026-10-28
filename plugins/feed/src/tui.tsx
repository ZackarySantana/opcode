/** @jsxImportSource @opentui/solid */

import { ThemeSurface } from "@opcode/ui"
import { Plugin } from "@opencode/plugin/tui"
import { createRemote, FeedsClient } from "./client"
import { FeedDialog } from "./dialog"
import { PLUGIN_ID } from "./model"
import { Sidebar } from "./sidebar"

export default Plugin.define({
  id: PLUGIN_ID,
  setup(api) {
    const feeds = new FeedsClient(createRemote(() => api.client, () => api.location ?? api.data.location.default()))
    // After the slot: below its appended sections, such as Pull requests. Later and Feed keep their config order.
    const unregisterSidebar = api.ui.slot({ after: "sidebar.content", render: () => <Sidebar feeds={feeds} /> })
    let opened = false
    api.keymap.layer(() => ({ mode: "global", commands: [{
      id: `${PLUGIN_ID}.open`, title: "Feeds", group: "Opcode", palette: true,
      description: "Timeline of subscribed status pages and feeds", slash: { name: "feed" },
      run() {
        api.ui.dialog.show(() => <ThemeSurface name="dialog"><FeedDialog feeds={feeds} /></ThemeSurface>, () => { opened = false })
        opened = true
        api.ui.dialog.set({ size: "large", centered: true })
      },
    }, {
      id: `${PLUGIN_ID}.refresh-all`, title: "Refresh feeds", group: "Opcode", palette: true,
      description: "Fetch every subscribed feed now", slash: { name: "feed-refresh" },
      run() {
        const count = feeds.subscriptions().length
        const error = feeds.error()
        api.ui.toast.show(count ? { title: "Feed", message: `Refreshing ${count} ${count === 1 ? "feed" : "feeds"}.`, variant: "info" }
          // With no feeds to show, a server that can't be reached, or can't read them, is the news.
          : error ? { title: "Feed", message: error, variant: "error" }
          : { title: "Feed", message: "No feeds yet. Subscribe to one in /feed.", variant: "warning" })
        feeds.refresh()
      },
    }] }))
    feeds.start()
    return () => {
      if (opened) api.ui.dialog.clear()
      try { unregisterSidebar() } finally { feeds.dispose() }
    }
  },
})
