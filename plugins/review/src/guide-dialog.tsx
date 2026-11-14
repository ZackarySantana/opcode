/** @jsxImportSource @opentui/solid */

import { KeyHints, usePalette, type KeyHint } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import type { ScrollBoxRenderable, SyntaxStyle } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, For, on, Show } from "solid-js"
import type { Answer } from "./ask"
import type { Activity, Deck } from "./guide"
import type { GuideRun } from "./guides"
import type { Row } from "./patch"
import { lineRange, locate, PLUGIN_ID, type Anchor } from "./review"
import { DiffRows } from "./segment"

/** How many of the latest things the model did the log shows while it writes. */
const LOG_LINES = 14

/**
 * The guided review, in a dialog over the panel: what the model is doing while it writes the deck, live, then the
 * deck itself, one slide at a time. Closing it leaves the guide as it is; the panel's guide button opens it again.
 */
export function GuideDialog(props: {
  run: () => GuideRun | undefined
  answer: () => Answer | undefined
  activity: () => readonly Activity[]
  writing: () => boolean
  model: () => string | undefined
  /** The diff's rows of a file now, which excerpts are drawn from. */
  rowsOf: (file: string) => readonly Row[] | undefined
  syntax?: () => SyntaxStyle | undefined
  onSlide: (index: number) => void
  /** Asks for a new deck. */
  onRestart: () => void
  /** Stops the deck being written. */
  onStop: () => void
}) {
  const api = usePlugin()
  const palette = usePalette()
  const dimensions = useTerminalDimensions()
  // The host places a dialog below its top margin: leave it room, as the tab dialogs do.
  const height = () => Math.max(10, Math.min(40, dimensions().height - 14))
  const deck = () => props.run()?.deck
  const index = () => Math.min(props.run()?.slide ?? 0, (deck()?.slides.length ?? 1) - 1)
  const slide = () => deck()?.slides[index()]
  const failed = () => {
    const run = props.run()
    if (!run) return undefined
    if (run.error) return run.error
    if (run.unreadable) return "The model's answer had no slides in it."
    return props.answer()?.state === "failed" ? props.answer()!.error ?? "No answer" : undefined
  }
  let scroll: ScrollBoxRenderable | undefined
  // A new slide starts at its top.
  createEffect(on(index, () => { if (scroll && !scroll.isDestroyed) scroll.scrollTo(0) }, { defer: true }))
  const go = (by: number) => {
    const slides = deck()?.slides.length ?? 0
    if (slides) props.onSlide(Math.max(0, Math.min(slides - 1, index() + by)))
  }
  const ready = () => !!deck()
  useDialogCommands(api, () => [
    { id: `${PLUGIN_ID}.guide.next`, title: "Next slide", bind: "right,l,n,space", enabled: ready, run: () => go(1) },
    { id: `${PLUGIN_ID}.guide.previous`, title: "Previous slide", bind: "left,h,p", enabled: ready, run: () => go(-1) },
    { id: `${PLUGIN_ID}.guide.first`, title: "First slide", bind: "home,g", enabled: ready, run: () => go(-Infinity) },
    { id: `${PLUGIN_ID}.guide.scroll.down`, title: "Scroll the slide down", bind: "down,j", enabled: ready, run: () => scroll?.scrollBy(1) },
    { id: `${PLUGIN_ID}.guide.scroll.up`, title: "Scroll the slide up", bind: "up,k", enabled: ready, run: () => scroll?.scrollBy(-1) },
    { id: `${PLUGIN_ID}.guide.restart`, title: "Write a new guided review", bind: "r", enabled: () => !props.writing(), run: props.onRestart },
    { id: `${PLUGIN_ID}.guide.stop`, title: "Stop writing the guided review", bind: "x", enabled: props.writing, run: props.onStop },
  ])
  const hints = (): KeyHint[] => props.writing()
    ? [{ key: "x", label: "stop", command: `${PLUGIN_ID}.guide.stop` }, { key: "esc", label: "close, it keeps writing" }]
    : ready()
      ? [{ key: "←/→", label: "slide" }, { key: "↑/↓", label: "scroll" }, { key: "r", label: "new guide", command: `${PLUGIN_ID}.guide.restart` }, { key: "esc", label: "close" }]
      : [{ key: "r", label: "try again", command: `${PLUGIN_ID}.guide.restart` }, { key: "esc", label: "close" }]
  return (
    <box flexDirection="column" minWidth={0} height={height()} paddingX={2} paddingTop={1}>
      <box flexDirection="row" flexShrink={0} minWidth={0} gap={2} marginBottom={1}>
        <text fg={palette.text} wrapMode="none" minWidth={0} flexShrink={1} flexGrow={1}>
          <b>Guided review</b> <span style={{ fg: palette.accent }}>{deck()?.title || props.run()?.view || ""}</span>
        </text>
        <Show when={deck()}>{(current) => <text fg={palette.muted} wrapMode="none" flexShrink={0}>slide {index() + 1}/{current().slides.length}</text>}</Show>
      </box>
      <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
        <Show when={slide()} fallback={
          <Show when={failed()} fallback={<Writing activity={props.activity()} model={props.model()} view={props.run()?.view} waiting={props.answer()?.state === "waiting"} />}>
            {(error) => <text fg={palette.error} wrapMode="word">! Couldn't write the guided review: {error()} Press r to try again.</text>}
          </Show>
        }>{(current) => (
          <scrollbox ref={(element: ScrollBoxRenderable) => { scroll = element }} flexGrow={1} minHeight={0}>
            <box flexDirection="column" minWidth={0} gap={1}>
              <text fg={palette.accent} wrapMode="word"><b>{current().title}</b></text>
              <Show when={current().body}><text fg={palette.text} wrapMode="word">{current().body}</text></Show>
              <For each={current().code}>{(anchor) => <Excerpt anchor={anchor} rows={props.rowsOf(anchor.file)} syntax={props.syntax?.()} />}</For>
              <Show when={index() === deck()!.slides.length - 1 && deck()!.skipped.length}>
                <text fg={palette.muted} wrapMode="word">Left out: {deck()!.skipped.map((entry) => entry.why ? `${entry.file} (${entry.why})` : entry.file).join(", ")}</text>
              </Show>
            </box>
          </scrollbox>
        )}</Show>
      </box>
      <Show when={deck()}>{(current) => <Dots count={current().slides.length} at={index()} onPick={props.onSlide} />}</Show>
      <box flexShrink={0} minWidth={0} paddingTop={1} paddingBottom={1}><KeyHints items={hints()} /></box>
    </box>
  )
}

/** While the deck is written: what the model is doing, newest last. */
function Writing(props: { activity: readonly Activity[]; model?: string; view?: string; waiting: boolean }) {
  const palette = usePalette()
  const shown = () => props.activity.slice(-LOG_LINES)
  const mark: Record<Activity["kind"], string> = { tool: "·", thinking: "~", slide: "▸" }
  return (
    <box flexDirection="column" minWidth={0} gap={1}>
      <text fg={palette.muted} wrapMode="word">
        {props.model ?? "The conversation's model"} is {props.waiting ? "about to read" : "reading"} the changes{props.view ? ` (${props.view})` : ""} and writing slides for them. You can close this; it keeps going, and the guide button opens it again.
      </text>
      <box flexDirection="column" minWidth={0}>
        <For each={shown()}>{(entry, at) => (
          <text wrapMode={entry.kind === "thinking" ? "word" : "none"} fg={entry.kind === "slide" ? palette.accent : entry.kind === "thinking" ? palette.muted : palette.text}>
            {mark[entry.kind]} {entry.kind === "slide" ? `Slide: ${entry.text}` : entry.kind === "thinking" && at() < shown().length - 1 ? entry.text.split("\n")[0] : entry.text}
          </text>
        )}</For>
        <text fg={palette.muted}>{shown().length ? "…" : "Starting…"}</text>
      </box>
    </box>
  )
}

/** A slide's code: the excerpt's rows in the diff as it is now, or its quoted lines when they're gone from it. */
function Excerpt(props: { anchor: Anchor; rows?: readonly Row[]; syntax?: SyntaxStyle }) {
  const palette = usePalette()
  const at = () => props.rows && locate(props.anchor, props.rows)
  return (
    <box flexDirection="column" minWidth={0}>
      <text fg={palette.muted} wrapMode="none">{props.anchor.file}:{lineRange(props.anchor)}{props.anchor.side === "old" ? " (removed)" : ""}</text>
      <Show when={at()} fallback={<text fg={palette.muted} wrapMode="none">{props.anchor.quote.join("\n")}{"\n"}(not in the diff any more)</text>}>
        {(found) => <DiffRows rows={props.rows!.slice(found().from, found().to + 1)} file={props.anchor.file} syntax={props.syntax} />}
      </Show>
    </box>
  )
}

/** Where you are in the deck, one dot per slide; clicking one goes there. */
function Dots(props: { count: number; at: number; onPick: (index: number) => void }) {
  const palette = usePalette()
  return (
    <box flexDirection="row" flexShrink={0} justifyContent="center" gap={1} paddingTop={1}>
      <For each={Array.from({ length: props.count }, (_, index) => index)}>{(index) => (
        <box onMouseDown={() => props.onPick(index)}><text fg={index === props.at ? palette.accent : palette.muted}>{index === props.at ? "●" : "○"}</text></box>
      )}</For>
    </box>
  )
}
