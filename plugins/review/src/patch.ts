/** Unified patches as numbered rows, and the smaller patches drawn between comments. Knows nothing about the host. */

export type Kind = "add" | "del" | "ctx"

export interface Row {
  readonly kind: Kind
  readonly text: string
  /** The row's line on each side it exists on. */
  readonly old?: number
  readonly new?: number
  /** Where the row sits on each side, also for rows missing from it: a segment starting here is numbered from these. */
  readonly oldAt: number
  readonly newAt: number
  /** Index of the hunk the row belongs to. */
  readonly hunk: number
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const SIGN: Record<string, Kind> = { "+": "add", "-": "del", " ": "ctx" }
/** Each kind's sign in a unified patch. */
export const MARK: Record<Kind, string> = { add: "+", del: "-", ctx: " " }

/** The rows of every hunk, in order. File headers and "\ No newline" markers are dropped. */
export function parsePatch(patch: string): Row[] {
  const rows: Row[] = []
  let hunk = -1
  let oldAt = 0
  let newAt = 0
  // Lines left in the current hunk on each side: a "---" inside a hunk is a removed line, not a header.
  let oldLeft = 0
  let newLeft = 0
  for (const line of patch.split("\n")) {
    const header = HEADER.exec(line)
    if (header) {
      hunk++
      oldAt = Number(header[1])
      newAt = Number(header[3])
      oldLeft = header[2] === undefined ? 1 : Number(header[2])
      newLeft = header[4] === undefined ? 1 : Number(header[4])
      // An empty side starts before its first line.
      if (oldLeft === 0) oldAt++
      if (newLeft === 0) newAt++
      continue
    }
    // Some tools drop the space that starts a blank context line.
    const kind = line === "" ? "ctx" : SIGN[line[0]!]
    // Each row needs room on the sides it uses; past the counts, lines are no longer part of the hunk.
    const fits = kind === "add" ? newLeft > 0 : kind === "del" ? oldLeft > 0 : oldLeft > 0 && newLeft > 0
    if (hunk < 0 || !kind || !fits) continue
    const text = line.slice(1)
    if (kind === "add") { rows.push({ kind, text, new: newAt, oldAt, newAt, hunk }); newAt++; newLeft-- }
    else if (kind === "del") { rows.push({ kind, text, old: oldAt, oldAt, newAt, hunk }); oldAt++; oldLeft-- }
    else { rows.push({ kind, text, old: oldAt, new: newAt, oldAt, newAt, hunk }); oldAt++; newAt++; oldLeft--; newLeft-- }
  }
  return rows
}

/** The line a row shows: its new line, or its old one when it was removed. */
export const lineOf = (row: Row) => row.kind === "del" ? row.old! : row.new!

export interface Segment {
  /** Index of its first row. */
  readonly start: number
  readonly rows: readonly Row[]
  readonly patch: string
}

/** Consecutive rows of one hunk, split after each break index, each as a patch of its own. */
export function segments(rows: readonly Row[], breaks: ReadonlySet<number> = new Set()): Segment[] {
  const result: Segment[] = []
  let start = 0
  for (let index = 0; index < rows.length; index++) {
    const last = index === rows.length - 1 || rows[index + 1]!.hunk !== rows[index]!.hunk || breaks.has(index)
    if (!last) continue
    const part = rows.slice(start, index + 1)
    result.push({ start, rows: part, patch: toPatch(part) })
    start = index + 1
  }
  return result
}

function toPatch(rows: readonly Row[]): string {
  const first = rows[0]!
  const olds = rows.filter((row) => row.kind !== "add").length
  const news = rows.filter((row) => row.kind !== "del").length
  // A side with no lines starts one before where it would be.
  const header = `@@ -${olds ? first.oldAt : first.oldAt - 1},${olds} +${news ? first.newAt : first.newAt - 1},${news} @@`
  return [header, ...rows.map((row) => MARK[row.kind] + row.text)].join("\n") + "\n"
}

/** The first row of each hunk. */
export const hunkStarts = (rows: readonly Row[]) => rows.flatMap((row, index) => index === 0 || rows[index - 1]!.hunk !== row.hunk ? [index] : [])

/** A short, stable fingerprint of a patch (FNV-1a). Equal patches give equal hashes. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}
