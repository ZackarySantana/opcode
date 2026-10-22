import type { usePalette } from "@opcode/ui"
import type { Phase } from "./status"

type Palette = ReturnType<typeof usePalette>

/** Glyph and color carry urgency; resolved items recede. */
export function phaseStyle(phase: Phase, palette: Palette): { glyph: string; color: Palette["text"]; title: Palette["text"]; strong: boolean } {
  switch (phase) {
    case "active": return { glyph: "●", color: palette.error, title: palette.text, strong: true }
    case "monitoring": return { glyph: "●", color: palette.warning, title: palette.text, strong: true }
    case "maintenance": return { glyph: "◐", color: palette.warning, title: palette.text, strong: false }
    case "scheduled": return { glyph: "○", color: palette.value, title: palette.text, strong: false }
    case "resolved": return { glyph: "✓", color: palette.muted, title: palette.muted, strong: false }
    case "news": return { glyph: "•", color: palette.accent, title: palette.text, strong: false }
  }
}

export function clockTime(time: number): string {
  return new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}
