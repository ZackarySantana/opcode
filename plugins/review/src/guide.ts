/**
 * Guided reviews: the prompt that asks the conversation's model for a walk through the diff, and the steps its
 * answer becomes, anchored to the diff's lines so they follow them as the agent edits. Knows nothing about the host.
 */

import { lineOf, type Row } from "./patch"
import { anchorOf, type Anchor } from "./review"

/** One stop on the walk: some lines, what they're for, and what to look at. */
export interface GuideStep {
  readonly anchor: Anchor
  readonly title: string
  readonly note: string
}

export interface Guide {
  readonly summary: string
  readonly steps: readonly GuideStep[]
  /** Changed files the walk leaves out, and why. */
  readonly skipped: readonly { readonly file: string; readonly why: string }[]
}

/** How much of the diff goes in the prompt; files past it are listed for the model to read itself. */
const PATCH_BUDGET = 60_000

/** The prompt for a guided review of these files' changes, as the view shows them. */
export function guidePrompt(input: { view: string; files: readonly { file: string; patch: string; additions: number; deletions: number }[] }): string {
  let budget = PATCH_BUDGET
  const shown: string[] = []
  const listed: string[] = []
  for (const entry of input.files) {
    if (entry.patch.length <= budget) { shown.push(`--- ${entry.file}\n${entry.patch.trim()}`); budget -= entry.patch.length }
    else listed.push(`${entry.file} (+${entry.additions} -${entry.deletions})`)
  }
  return [
    `Walk me through these changes (${input.view}) as a guided code review, in the order that makes them easiest to understand.`,
    "Start where the change starts, such as a new type, the core logic, or the entry point, then follow what depends on it, with tests and small follow-on edits last. Group lines that belong together into one step, even across hunks of a file. Cover every meaningful change; leave out only trivial ones (lockfiles, formatting, generated files) and say so.",
    "For each step, say what the lines do and why, and what deserves a careful look: risky logic, edge cases, behavior changes, and anything that looks wrong. Be concrete and brief: two to five sentences, plain text.",
    "You can read and search the repository to check callers, definitions, or tests first. Don't edit anything.",
    "Reply with only a JSON object in a ```json block, in this shape:",
    "```json",
    '{"summary": "two or three sentences on what the change does", "steps": [{"file": "path/as/in/the/diff", "start": 10, "end": 24, "side": "new", "title": "a few words", "note": "what to look at"}], "skipped": [{"file": "package-lock.json", "why": "generated"}]}',
    "```",
    'Line numbers are the file\'s after the change; use "side": "old" only for lines that were removed. Use the file paths exactly as the diff shows them.',
    "",
    "The diff:",
    "```diff",
    shown.join("\n\n"),
    "```",
    ...listed.length ? ["", `Also changed, too large to include here; read them if they matter: ${listed.join(", ")}.`] : [],
  ].join("\n")
}

const text = (value: unknown) => typeof value === "string" ? value.trim() : ""
const line = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.round(value)) : undefined

/** The JSON in a reply: its ```json block, else the outermost braces. */
function json(reply: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(reply)?.[1]
  const braces = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)
  for (const candidate of [fenced, braces]) {
    if (!candidate) continue
    try { return JSON.parse(candidate) } catch { /* Try the next. */ }
  }
  return undefined
}

/** The rows of a file a step names: those showing its lines on its side, else the row nearest them. */
function rowsFor(rows: readonly Row[], side: "new" | "old", start: number, end: number): { from: number; to: number } | undefined {
  const on = (row: Row) => side === "old" ? row.old : row.new
  const inside = rows.flatMap((row, index) => { const at = on(row); return at !== undefined && at >= start && at <= end ? [index] : [] })
  if (inside.length) return { from: inside[0]!, to: inside.at(-1)! }
  if (!rows.length) return undefined
  // Lines the diff doesn't show, such as context the model read from the file: the nearest changed row stands in.
  const nearest = rows.reduce((best, row, index) => Math.abs(lineOf(row) - start) < Math.abs(lineOf(rows[best]!) - start) ? index : best, 0)
  return { from: nearest, to: nearest }
}

/**
 * The guide in a reply, with each step anchored to the rows it names in the diff, or undefined when the reply has
 * no usable guide. Steps on files the diff doesn't change are dropped.
 */
export function parseGuide(reply: string, rowsOf: (file: string) => readonly Row[] | undefined): Guide | undefined {
  const value = json(reply) as { summary?: unknown; steps?: unknown; skipped?: unknown } | undefined
  if (!value || typeof value !== "object" || !Array.isArray(value.steps)) return undefined
  const steps = value.steps.flatMap((raw): GuideStep[] => {
    if (!raw || typeof raw !== "object") return []
    const step = raw as Record<string, unknown>
    const file = text(step.file).replace(/^[ab]\//, "")
    const rows = rowsOf(file)
    const start = line(step.start)
    if (!rows?.length || start === undefined) return []
    const end = Math.max(start, line(step.end) ?? start)
    const at = rowsFor(rows, step.side === "old" ? "old" : "new", start, end)
    if (!at) return []
    return [{ anchor: anchorOf(file, rows, at.from, at.to), title: text(step.title) || `${file}:${start}`, note: text(step.note) }]
  })
  if (!steps.length) return undefined
  const skipped = Array.isArray(value.skipped)
    ? value.skipped.flatMap((raw) => raw && typeof raw === "object" && text((raw as Record<string, unknown>).file) ? [{ file: text((raw as Record<string, unknown>).file), why: text((raw as Record<string, unknown>).why) }] : [])
    : []
  return { summary: text(value.summary), steps, skipped }
}
