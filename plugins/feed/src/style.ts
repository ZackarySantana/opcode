import type { Color, Mark } from "@opcode/tabs"
import type { usePalette } from "@opcode/ui"
import { feedState, type FetchResult } from "./model"
import type { FeedKind } from "./presets"
import type { Phase } from "./status"

type Palette = ReturnType<typeof usePalette>

/** Glyph and color carry urgency; resolved items recede. */
export function phaseStyle(phase: Phase, palette: Palette): Mark {
  switch (phase) {
    case "active": return { glyph: "●", color: palette.error, title: palette.text, strong: true }
    case "monitoring": return { glyph: "●", color: palette.warning, title: palette.text, strong: true }
    case "maintenance": return { glyph: "◐", color: palette.warning, title: palette.text, strong: false }
    case "scheduled": return { glyph: "○", color: palette.value, title: palette.text, strong: false }
    case "resolved": return { glyph: "✓", color: palette.muted, title: palette.muted, strong: false }
    case "news": return { glyph: "•", color: palette.accent, title: palette.text, strong: false }
  }
}

/** A feed's current state, colored by urgency, as a row's detail. */
export function feedLine(result: FetchResult | undefined, kind: FeedKind, now: number, palette: Palette): { detail: string; detailColor?: Color } {
  const state = feedState(result, kind, now)
  return { detail: state.text, detailColor: state.phase ? phaseStyle(state.phase, palette).color : undefined }
}

export function clockTime(time: number): string {
  return new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}
