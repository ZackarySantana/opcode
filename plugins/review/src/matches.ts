/** Searching the diff: the changed files whose path matches, and the diff lines whose text does. Knows nothing about the host. */

import { lineOf, type Row } from "./patch"

export interface FileMatch {
  readonly kind: "file"
  readonly file: string
  /** Where the query matched in the path. */
  readonly start: number
  readonly end: number
}

export interface LineMatch {
  readonly kind: "line"
  readonly file: string
  /** The line as the diff shows it: new, or old for a removed row. */
  readonly line: number
  readonly old: boolean
  readonly sign: "+" | "-" | " "
  readonly text: string
  /** Where the query matched in the text. */
  readonly start: number
  readonly end: number
}

export type Match = FileMatch | LineMatch

export interface Matches {
  /** Files first, those whose name matches before those whose folders do; then lines, in the files' order. */
  readonly matches: readonly Match[]
  readonly files: number
  readonly lines: number
  /** More lines matched than are listed. */
  readonly truncated: boolean
}

const signOf: Record<Row["kind"], LineMatch["sign"]> = { add: "+", del: "-", ctx: " " }

/** Case-insensitive unless the query has a capital letter, as editors search. */
const caseFor = (query: string) => query === query.toLowerCase() ? (text: string) => text.toLowerCase() : (text: string) => text

/** Searches the paths and lines of the diff's files, in the order given. An empty query matches nothing. */
export function searchDiff(query: string, files: readonly { readonly file: string; readonly rows: readonly Row[] }[], limit = 500): Matches {
  if (!query) return { matches: [], files: 0, lines: 0, truncated: false }
  const fold = caseFor(query)
  const needle = fold(query)
  const named: FileMatch[] = []
  const foldered: FileMatch[] = []
  const lines: LineMatch[] = []
  let truncated = false
  for (const { file, rows } of files) {
    const at = fold(file).lastIndexOf(needle)
    if (at >= 0) (at >= file.lastIndexOf("/") + 1 ? named : foldered).push({ kind: "file", file, start: at, end: at + query.length })
    for (const row of rows) {
      const start = fold(row.text).indexOf(needle)
      if (start < 0) continue
      if (lines.length >= limit) { truncated = true; break }
      lines.push({ kind: "line", file, line: lineOf(row), old: row.kind === "del", sign: signOf[row.kind], text: row.text, start, end: start + query.length })
    }
  }
  return { matches: [...named, ...foldered, ...lines], files: named.length + foldered.length, lines: lines.length, truncated }
}
