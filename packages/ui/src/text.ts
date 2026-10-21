import { measureEditText, type WidthMethod } from "@opentui/core"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Measure terminal cells using the host renderer's width method when supplied. */
export const cellWidth = (text: string, widthMethod: WidthMethod = "unicode") => measureEditText(text, { widthMethod })

/** Fit single-line text to a cell budget without splitting a grapheme. */
export function shorten(text: string, width: number, widthMethod: WidthMethod = "unicode") {
  const clean = text.replace(/[\r\n\t]/g, " ")
  const budget = Math.max(0, Math.floor(width))
  if (cellWidth(clean, widthMethod) <= budget) return clean
  const available = budget - cellWidth("…", widthMethod)
  if (available < 0) return ""
  let result = "", used = 0
  for (const { segment } of graphemes.segment(clean)) {
    const cells = cellWidth(segment, widthMethod)
    if (used + cells > available) break
    result += segment
    used += cells
  }
  return `${result}…`
}
