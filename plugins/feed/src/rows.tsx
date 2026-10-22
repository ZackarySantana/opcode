/** @jsxImportSource @opentui/solid */

import { usePalette, useText } from "@opcode/ui"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { feedState, type FetchResult } from "./model"
import type { FeedKind } from "./presets"
import { phaseStyle } from "./style"

const LABEL_WIDTH = 34

/** One line: a feed's label, then its current state colored by urgency. Used by Edit and the feed picker. */
export function FeedLine(props: {
  label: string; labelColor: ReturnType<typeof usePalette>["text"]; selected: boolean; width: number; now: number
  kind: FeedKind; result?: FetchResult; showState: boolean
}) {
  const palette = usePalette()
  const text = useText()
  const state = () => props.showState ? feedState(props.result, props.kind, props.now) : { text: "" }
  const fg = () => props.selected ? palette.selectedText : undefined
  return <>
    <text wrapMode="none" width={LABEL_WIDTH} flexShrink={0} fg={fg() ?? props.labelColor}>{text.shorten(props.label, LABEL_WIDTH)}</text>
    <text wrapMode="none" flexGrow={1} minWidth={0} fg={fg() ?? (state().phase ? phaseStyle(state().phase!, palette).color : palette.muted)}>
      {text.shorten(state().text, Math.max(0, props.width - LABEL_WIDTH - 4))}
    </text>
  </>
}

/** A selectable list row; the selection is a highlighted bar, as in /context. */
export function Row(props: { selected: boolean; children: JSX.Element }) {
  const palette = usePalette()
  return (
    <box flexDirection="row" height={1} flexShrink={0} gap={2} backgroundColor={props.selected ? palette.selectedBackground : undefined}>
      {props.children}
    </box>
  )
}

export function Heading(props: { title: string }) {
  const palette = usePalette()
  return <text fg={palette.accent} flexShrink={0}><b>{props.title}</b></text>
}
