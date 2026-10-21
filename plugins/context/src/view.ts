/** A bounded window which keeps the selected row visible after navigation, resize, or refresh. */
export function listWindow(length: number, selection: number, height: number) {
  const selected = Math.max(0, Math.min(selection, Math.max(0, length - 1)))
  const size = Math.max(1, Math.floor(height))
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), length - size))
  return { selected, start, end: Math.min(length, start + size) }
}

export { cellWidth, shorten } from "@opcode/ui"

export const percent = (value: number | undefined) => value === undefined ? "unavailable" : `${(value * 100).toFixed(1)}%`
