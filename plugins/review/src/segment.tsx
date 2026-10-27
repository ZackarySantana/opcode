/** @jsxImportSource @opentui/solid */

import { usePlugin } from "@opencode/plugin/tui"
import { pathToFiletype, SyntaxStyle, type LineNumberRenderable, type RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { lineOf, type Row } from "./patch"
import { wordMarks, type Mark } from "./symbols"

/** Style names the marks are drawn with; `useSyntax` registers them with the theme's colors. */
export const MARK_STYLE: Record<Mark["style"], string> = { word: "review.word", token: "review.token" }

/**
 * Rows of one hunk as a diff: line numbers and signs in the gutter, highlighted code, the cursor's line set apart,
 * and the picked name with its other uses marked in the text. The same parts `<diff>` draws with, which can do both.
 */
export function DiffRows(props: {
  rows: readonly Row[]
  file: string
  syntax?: SyntaxStyle
  /** The cursor's row within these rows, if it is here. */
  cursor?: number
  /** The name to mark, and where the picked one is within these rows. */
  word?: string
  picked?: { line: number; start: number }
}) {
  const api = usePlugin()
  const renderer = useRenderer()
  const colors = () => api.theme.diff
  // Code needs a style to draw with; without the theme's, a plain one, as <diff> keeps.
  let plain: SyntaxStyle | undefined
  const style = () => props.syntax ?? (plain ??= SyntaxStyle.create(renderer.nativeScene))
  onCleanup(() => { const owned = plain; if (owned) void renderer.idle().then(() => owned.destroy()) })
  const content = createMemo(() => props.rows.map((row) => row.text).join("\n"))
  const lineNumbers = createMemo(() => new Map(props.rows.map((row, index) => [index, lineOf(row)])))
  const lineSigns = createMemo(() => new Map(props.rows.flatMap((row, index) => row.kind === "ctx" ? [] : [[index, {
    after: row.kind === "add" ? " +" : " -", afterColor: row.kind === "add" ? colors().text.added : colors().text.removed,
  }] as const])))
  const lineColors = createMemo(() => new Map(props.rows.flatMap((row, index): [number, { gutter: RGBA; content: RGBA }][] => {
    // The cursor's line takes the stronger shade of its kind, gutter and text alike, so it stands out while scrolling.
    if (index === props.cursor) {
      const strong = row.kind === "add" ? colors().highlight.added : row.kind === "del" ? colors().highlight.removed : api.theme.background.raised.max
      return [[index, { gutter: strong, content: strong }]]
    }
    if (row.kind === "add") return [[index, { gutter: colors().lineNumber.background.added, content: colors().background.added }]]
    if (row.kind === "del") return [[index, { gutter: colors().lineNumber.background.removed, content: colors().background.removed }]]
    return [[index, { gutter: colors().background.context, content: colors().background.context }]]
  })))
  // The gutter takes these through methods, not props.
  let gutter: LineNumberRenderable | undefined
  createEffect(() => gutter?.setLineNumbers(lineNumbers()))
  createEffect(() => gutter?.setLineSigns(lineSigns()))
  createEffect(() => gutter?.setLineColors(lineColors()))
  // A new function re-highlights the text, so it changes only when what's marked here does.
  const markKey = createMemo(() => JSON.stringify([props.word, props.picked]))
  const onHighlight = createMemo(() => {
    markKey()
    const marks = wordMarks(props.rows.map((row) => row.text), props.file, props.word, props.picked)
    return (highlights: [number, number, string, ...unknown[]][]) => marks.length
      ? [...highlights, ...marks.map((mark) => [mark.start, mark.end, MARK_STYLE[mark.style]] as [number, number, string])]
      : highlights
  })
  return (
    <line_number ref={(element: LineNumberRenderable) => { gutter = element }} flexGrow={1} minWidth={0} fg={colors().lineNumber.text} bg={colors().background.context}>
      {/* Without a grammar nothing is highlighted, and the marks would never be drawn: plain text still runs the hook. */}
      <code content={content()} filetype={pathToFiletype(props.file) ?? "text"} syntaxStyle={style()} wrapMode="none" fg={colors().text.context}
        width="100%" onHighlight={onHighlight() as never} />
    </line_number>
  )
}
