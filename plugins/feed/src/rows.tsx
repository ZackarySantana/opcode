/** @jsxImportSource @opentui/solid */

import { Line, type Color } from "@opcode/tabs"
import { usePalette } from "@opcode/ui"
import { feedState, type FetchResult } from "./model"
import type { FeedKind } from "./presets"
import { phaseStyle } from "./style"

/** A feed's label, then its current state colored by urgency. */
export function feedLine(result: FetchResult | undefined, kind: FeedKind, now: number, palette: ReturnType<typeof usePalette>): { detail: string; detailColor?: Color } {
  const state = feedState(result, kind, now)
  return { detail: state.text, detailColor: state.phase ? phaseStyle(state.phase, palette).color : undefined }
}

/** One Subscribe row's content. */
export function FeedLine(props: { label: string; labelColor: Color; selected: boolean; now: number; kind: FeedKind; result?: FetchResult; showState: boolean }) {
  const palette = usePalette()
  const state = () => props.showState ? feedLine(props.result, props.kind, props.now, palette) : { detail: "" }
  return <Line label={props.label} labelColor={props.labelColor} selected={props.selected} detail={state().detail} detailColor={state().detailColor} />
}
