/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { Show } from "solid-js"
import { ReviewController } from "./host"
import { ReviewPanel } from "./panel"
import { PLUGIN_ID } from "./review"
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
    ]
    /** Opens the panel, or gives it the keyboard when it's already open. */
    const open = (command: string) => {
      // Already open: take input instead, so the command always lands in the panel.
      if (api.ui.panel.current()?.name === PLUGIN_ID) { review.requestFocus(); return true }
      // Full screen in place of the conversation, on every terminal: the diff needs the width, and the host would
      // force it on a narrow one anyway.
      if (api.ui.panel.open(PLUGIN_ID, { presentation: "fullscreen" })) return true
      api.ui.toast.show({ variant: "warning", title: "Review", message: `Open a session first: ${command} reviews its changes.` })
      return false
    }
    api.keymap.layer(() => ({ mode: "global", commands: [
      {
        id: `${PLUGIN_ID}.open`, title: "Review changes", group: "Opcode", palette: true,
        description: "Comment on the agent's diffs and steer it while it works", slash: { name: "diffs" },
        run() { open("/diffs") },
      },
      {
        id: `${PLUGIN_ID}.guided`, title: "Guided review of changes", group: "Opcode", palette: true,
        description: "The conversation's model walks you through the agent's diffs, step by step", slash: { name: "diffs-guided" },
        // The panel starts the guide (or resumes it) once it has the changes.
        run() { if (open("/diffs-guided")) review.guides.request() },
      },
    ] }))
    return () => {
      try { for (const stop of unregister) stop() } finally { review.dispose() }
    }
  },
})
