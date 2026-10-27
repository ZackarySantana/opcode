/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { Show } from "solid-js"
import { ReviewController } from "./host"
import { ReviewPanel } from "./panel"
import { PLUGIN_ID } from "./review"
import { Sidebar } from "./sidebar"
import { useSyntax } from "./syntax"

/** The panel with the host theme's syntax colors: one style per open panel, rebuilt with the theme. */
function ThemedPanel(props: { api: Context; panel: PanelInput; review: ReviewController }) {
  const syntax = useSyntax(props.api)
  return <ReviewPanel panel={props.panel} review={props.review} syntax={syntax} />
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(api) {
    const review = new ReviewController(api)
    const unregister = [
      api.ui.slot({
        append: "session.panel",
        render: (panel) => <Show when={panel.name === PLUGIN_ID}><ThemedPanel api={api} panel={panel} review={review} /></Show>,
      }),
      api.ui.slot({ append: "sidebar.content", render: ({ sessionID }) => <Sidebar review={review} sessionID={sessionID} /> }),
    ]
    api.keymap.layer(() => ({ mode: "global", commands: [{
      id: `${PLUGIN_ID}.open`, title: "Review changes", group: "Opcode", palette: true,
      description: "Comment on the agent's diffs and steer it while it works", slash: { name: "review" },
      run() {
        // Already open: take input instead, so /review always lands in the panel.
        if (api.ui.panel.current()?.name === PLUGIN_ID) review.requestFocus()
        else if (!api.ui.panel.open(PLUGIN_ID)) api.ui.toast.show({ variant: "warning", title: "Review", message: "Open a session first: /review reviews its changes." })
      },
    }] }))
    return () => {
      try { for (const stop of unregister) stop() } finally { review.dispose() }
    }
  },
})
