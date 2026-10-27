/** @jsxImportSource @opentui/solid */

import { usePalette, useText } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import { CliRenderEvents, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { isQuestion, lineRange, type Comment, type Delivery, type Reply } from "./review"

const state: Record<Delivery, string> = {
  draft: "draft",
  sending: "sending",
  unconfirmed: "not confirmed",
  pending: "waiting for the agent",
  sent: "sent",
}

/** Every comment in the session, oldest first, each with where it is, how it stands, and the agent's reply in full. */
export function CommentsView(props: {
  comments: readonly Comment[]
  deliveries: ReadonlyMap<string, Delivery>
  replies: Readonly<Record<string, Reply>>
  /** Comments whose reply is new since this view last showed it. */
  fresh: ReadonlySet<string>
  selected: number
  width: number
  onSelect: (index: number) => void
}) {
  const palette = usePalette()
  const text = useText()
  const api = usePlugin()
  let scroll: ScrollBoxRenderable | undefined
  createEffect(on(() => props.selected, (index) => {
    const follow = () => { if (scroll && !scroll.isDestroyed) scroll.scrollChildIntoView(`comment-${index}`) }
    follow()
    api.renderer.once(CliRenderEvents.FRAME, follow)
    api.renderer.requestRender()
    onCleanup(() => { api.renderer.off(CliRenderEvents.FRAME, follow) })
  }))
  const counts = () => {
    const states = props.comments.map((comment) => props.deliveries.get(comment.id) ?? "draft")
    const drafts = states.filter((value) => value === "draft" || value === "unconfirmed").length
    const replied = props.comments.filter((comment) => props.replies[comment.id]).length
    return [
      `${props.comments.length} ${props.comments.length === 1 ? "comment" : "comments"}`,
      drafts && `${drafts} to send`,
      replied && `${replied} replied`,
    ].filter(Boolean).join(" · ")
  }
  const replyColor = (reply: Reply) => reply.status === "done" ? palette.success : reply.status === "declined" ? palette.warning : palette.value
  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      <text fg={palette.muted} wrapMode="none" flexShrink={0}><b><span style={{ fg: palette.text }}>Comments</span></b>  {counts()}</text>
      <Show when={props.comments.length} fallback={<text fg={palette.muted} wrapMode="word">No comments yet. Press c on a line of the diff to write one.</text>}>
        <scrollbox ref={(element: ScrollBoxRenderable) => { scroll = element }} flexGrow={1} minHeight={0} marginTop={1}>
          <For each={props.comments}>{(comment, index) => {
            const selected = () => index() === props.selected
            const delivery = () => props.deliveries.get(comment.id) ?? "draft"
            const reply = () => props.replies[comment.id]
            return (
              <box id={`comment-${index()}`} flexDirection="column" minWidth={0} marginBottom={1} paddingX={1} border={["left"]}
                borderColor={selected() ? palette.accent : comment.sent ? palette.border : palette.value}
                backgroundColor={selected() ? palette.background : undefined} onMouseDown={() => props.onSelect(index())}>
                <text fg={palette.muted} wrapMode="none">
                  <span style={{ fg: palette.accent }}>{comment.id}</span> {text.shorten(comment.file, Math.max(10, props.width - 40))}:{lineRange(comment)}
                  {comment.side === "old" ? " (removed)" : comment.outside ? " (outside the diff)" : ""}{isQuestion(comment.text) ? " · question" : ""} · {state[delivery()]}
                </text>
                <text fg={palette.text} wrapMode="word">{comment.text}</text>
                <Show when={reply()}>{(answer) => (
                  <text wrapMode="word" fg={replyColor(answer())}>
                    <Show when={props.fresh.has(comment.id)}><span style={{ fg: palette.accent }}>● new  </span></Show>↳ {answer().status}: <span style={{ fg: palette.text }}>{answer().reply}</span>
                  </text>
                )}</Show>
              </box>
            )
          }}</For>
        </scrollbox>
      </Show>
    </box>
  )
}
