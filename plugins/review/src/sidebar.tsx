/** @jsxImportSource @opentui/solid */

import { useClick } from "@opcode/tabs"
import { Section, usePalette } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, on, Show } from "solid-js"
import type { ReviewController } from "./host"
import { PLUGIN_ID } from "./review"

/** How the session's review stands: drafts to send, comments the agent has yet to take, and replies. Omitted until there are comments. */
export function Sidebar(props: { review: ReviewController; sessionID: string }) {
  const api = usePlugin()
  const palette = usePalette()
  // The same command as /review: open the panel, or focus it when it's already open.
  const click = useClick(() => api.keymap.dispatch(`${PLUGIN_ID}.open`))
  const sessionID = () => api.data.session.root(props.sessionID)
  // Replies the agent sent while no terminal was looking.
  createEffect(on(sessionID, (id) => { if (props.review.review(id).comments.some((comment) => comment.sent)) props.review.loadReplies(id) }))
  const counts = createMemo(() => {
    const { comments } = props.review.review(sessionID())
    const replies = props.review.repliesFor(sessionID())
    const states = [...props.review.deliveries(sessionID()).values()]
    return {
      total: comments.length,
      // A send the host never confirmed is still yours to send.
      drafts: states.filter((state) => state === "draft" || state === "unconfirmed").length,
      waiting: states.filter((state) => state === "pending" || state === "sending").length,
      replies: comments.filter((comment) => replies[comment.id]).length,
    }
  })
  const line = () => {
    const { drafts, waiting, replies } = counts()
    return [drafts && `${drafts} to send`, waiting && `${waiting} waiting`, replies && `${replies} replied`].filter(Boolean).join(" · ") || "all sent"
  }
  return (
    <Show when={counts().total}>
      <box paddingTop={1} {...click.handlers}>
        <Section title="Review">
          <text fg={counts().drafts || click.hovered() ? palette.text : palette.muted} wrapMode="word">{line()}</text>
        </Section>
      </box>
    </Show>
  )
}
