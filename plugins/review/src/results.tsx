/** @jsxImportSource @opentui/solid */

import { usePalette, useText } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import { CliRenderEvents, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import type { Matches } from "./matches"

/** The search box over the diff and what it found: files by path, then diff lines. Selecting one opens it. */
export function SearchResults(props: {
  query: string
  typing: boolean
  found: Matches
  selected: number
  width: number
  onInput: (query: string) => void
  onSubmit: () => void
  onSelect: (index: number) => void
}) {
  const palette = usePalette()
  const text = useText()
  const api = usePlugin()
  let scroll: ScrollBoxRenderable | undefined
  createEffect(on(() => props.selected, (index) => {
    const follow = () => { if (scroll && !scroll.isDestroyed) scroll.scrollChildIntoView(`match-${index}`) }
    follow()
    api.renderer.once(CliRenderEvents.FRAME, follow)
    api.renderer.requestRender()
    onCleanup(() => { api.renderer.off(CliRenderEvents.FRAME, follow) })
  }))
  /** The text with the matched part picked out, cut to the width. */
  const marked = (value: string, start: number, end: number, room: number, selected: boolean) => {
    // Long lines keep the match in view: drop what's far before it.
    const from = Math.max(0, Math.min(start - 10, value.length - room))
    const shown = text.shorten(value.slice(from), Math.max(4, room))
    const cut = (index: number) => Math.max(0, Math.min(shown.length, index - from))
    return (
      <>
        {shown.slice(0, cut(start))}
        <span style={selected ? { fg: palette.selectedText } : { fg: palette.background, bg: palette.accent }}>{shown.slice(cut(start), cut(end))}</span>
        {shown.slice(cut(end))}
      </>
    )
  }
  const summary = () => {
    const { files, lines, truncated } = props.found
    if (!props.query) return "Type to search the paths and lines of the diff."
    if (!files && !lines) return "Nothing in the diff matches."
    return `${files} ${files === 1 ? "file" : "files"} · ${lines}${truncated ? "+" : ""} ${lines === 1 ? "line" : "lines"}`
  }
  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      <box flexDirection="row" flexShrink={0} minWidth={0} border={["bottom"]} borderColor={palette.border}>
        <text fg={palette.text} flexShrink={0}>/ </text>
        <Show when={props.typing} fallback={<text fg={props.query ? palette.accent : palette.muted} wrapMode="none" flexGrow={1} minWidth={0}>{props.query || "search"}</text>}>
          <input focused flexGrow={1} value={props.query} placeholder="search files and lines" onInput={props.onInput} onSubmit={props.onSubmit}
            textColor={palette.text} focusedTextColor={palette.text} placeholderColor={palette.muted} />
        </Show>
      </box>
      <text fg={palette.muted} wrapMode="none" flexShrink={0}>{summary()}</text>
      <scrollbox ref={(element: ScrollBoxRenderable) => { scroll = element }} flexGrow={1} minHeight={0}>
        <For each={props.found.matches}>{(match, index) => {
          const selected = () => index() === props.selected
          return (
            <box id={`match-${index()}`} flexDirection="row" minWidth={0} backgroundColor={selected() ? palette.selectedBackground : undefined} onMouseDown={() => props.onSelect(index())}>
              <Switch>
                <Match when={match.kind === "file" && match}>{(file) => (
                  <text wrapMode="none" fg={selected() ? palette.selectedText : palette.text}>
                    <span style={{ fg: selected() ? palette.selectedText : palette.muted }}>file  </span>{marked(file().file, file().start, file().end, props.width - 8, selected())}
                  </text>
                )}</Match>
                <Match when={match.kind === "line" && match}>{(line) => {
                  const where = `${text.shorten(line().file, Math.max(10, Math.floor(props.width / 3)))}:${line().line} `
                  const sign = () => line().sign === "+" ? palette.success : line().sign === "-" ? palette.error : palette.muted
                  return (
                    <text wrapMode="none" fg={selected() ? palette.selectedText : palette.text}>
                      <span style={{ fg: selected() ? palette.selectedText : palette.muted }}>{where}</span>
                      <span style={{ fg: selected() ? palette.selectedText : sign() }}>{line().sign}</span>
                      {marked(line().text, line().start, line().end, props.width - where.length - 4, selected())}
                    </text>
                  )
                }}</Match>
              </Switch>
            </box>
          )
        }}</For>
      </scrollbox>
    </box>
  )
}
