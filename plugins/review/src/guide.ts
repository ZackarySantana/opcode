/**
 * Guided reviews: the prompt that asks the conversation's model to present the diff as a short slide deck, the
 * deck its answer becomes (each slide's code anchored to the diff, so it follows its lines as the agent edits), and
 * what the model is doing while it writes. Knows nothing about the host.
 */

import type { SessionMessageInfo } from "@opencode/client"
import { lineOf, type Row } from "./patch"
import { anchorOf, type Anchor } from "./review"

/** One slide: an idea of the change, explained, with the code that shows it, from any files. */
export interface Slide {
  readonly title: string
  readonly body: string
  readonly code: readonly Anchor[]
}

export interface Deck {
  readonly title: string
  readonly slides: readonly Slide[]
  /** Changed files the deck leaves out, and why. */
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
    `Present these changes (${input.view}) to me as a short slide deck for a code review, the way you'd walk a teammate through them in a meeting.`,
    "Organize it by idea, not by file: one slide per thing the change does, and a slide can show code from several files. Start with an overview slide (what changed and why, usually without code), then the core change, then what builds on it, and end with a slide on risks and what to check before merging. Four to ten slides is typical; fewer for a small change.",
    "On each slide, explain what the code does and why, and what deserves a careful look: risky logic, edge cases, behavior changes, anything that looks wrong. Two to five sentences of plain text, no headings or bullet syntax. Show at most three excerpts of the changed lines per slide.",
    "You can read and search the repository to check callers, definitions, or tests first. Don't edit anything.",
    "Reply with only a JSON object in a ```json block, in this shape:",
    "```json",
    '{"title": "a few words naming the change", "slides": [{"title": "a few words", "body": "the explanation", "code": [{"file": "path/as/in/the/diff", "start": 10, "end": 24, "side": "new"}]}], "skipped": [{"file": "package-lock.json", "why": "generated"}]}',
    "```",
    'Line numbers are the file\'s after the change; use "side": "old" only for lines that were removed. Use the file paths exactly as the diff shows them. Leave out only trivial changes (lockfiles, formatting, generated files), and list them in skipped.',
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

/** The rows of a file an excerpt names: those showing its lines on its side, else the row nearest them. */
function rowsFor(rows: readonly Row[], side: "new" | "old", start: number, end: number): { from: number; to: number } | undefined {
  const on = (row: Row) => side === "old" ? row.old : row.new
  const inside = rows.flatMap((row, index) => { const at = on(row); return at !== undefined && at >= start && at <= end ? [index] : [] })
  if (inside.length) return { from: inside[0]!, to: inside.at(-1)! }
  if (!rows.length) return undefined
  // Lines the diff doesn't show, such as context the model read from the file: the nearest changed row stands in.
  const nearest = rows.reduce((best, row, index) => Math.abs(lineOf(row) - start) < Math.abs(lineOf(rows[best]!) - start) ? index : best, 0)
  return { from: nearest, to: nearest }
}

/** An excerpt anchored to the diff rows it names, or undefined when its file isn't in the diff. */
function excerptOf(raw: unknown, rowsOf: (file: string) => readonly Row[] | undefined): Anchor | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const entry = raw as Record<string, unknown>
  const file = text(entry.file).replace(/^[ab]\//, "")
  const rows = rowsOf(file)
  const start = line(entry.start)
  if (!rows?.length || start === undefined) return undefined
  const at = rowsFor(rows, entry.side === "old" ? "old" : "new", start, Math.max(start, line(entry.end) ?? start))
  return at && anchorOf(file, rows, at.from, at.to)
}

/** The deck in a reply, or undefined when the reply has none. Excerpts of files the diff doesn't change are dropped. */
export function parseDeck(reply: string, rowsOf: (file: string) => readonly Row[] | undefined): Deck | undefined {
  const value = json(reply) as { title?: unknown; slides?: unknown; skipped?: unknown } | undefined
  if (!value || typeof value !== "object" || !Array.isArray(value.slides)) return undefined
  const slides = value.slides.flatMap((raw): Slide[] => {
    if (!raw || typeof raw !== "object") return []
    const slide = raw as Record<string, unknown>
    const title = text(slide.title)
    const body = text(slide.body)
    if (!title && !body) return []
    const code = (Array.isArray(slide.code) ? slide.code : []).flatMap((entry) => excerptOf(entry, rowsOf) ?? [])
    return [{ title: title || "Untitled", body, code }]
  })
  if (!slides.length) return undefined
  const skipped = Array.isArray(value.skipped)
    ? value.skipped.flatMap((raw) => raw && typeof raw === "object" && text((raw as Record<string, unknown>).file) ? [{ file: text((raw as Record<string, unknown>).file), why: text((raw as Record<string, unknown>).why) }] : [])
    : []
  return { title: text(value.title), slides, skipped }
}

/** Something the model did while writing, for the live log. */
export type Activity =
  | { readonly kind: "tool"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "slide"; readonly text: string }

const short = (path: unknown) => typeof path === "string" ? path.replace(/^.*?\/(?=[^/]+\/[^/]+$)/, "…/") : ""

/** What a tool call did, in a few words. */
function toolText(name: string, input: unknown): string {
  const fields = input && typeof input === "object" ? input as Record<string, unknown> : {}
  if (name === "read") return `Reading ${short(fields.path) || "a file"}`
  if (name === "grep") return `Searching for "${text(fields.pattern)}"${fields.path ? ` in ${short(fields.path)}` : ""}`
  if (name === "glob") return `Looking for ${text(fields.pattern) || "files"}`
  return `Using ${name}`
}

/** Slide titles in a reply that's still being written: the deck as far as it goes. */
const TITLE = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g

/**
 * What the model has done since the prompt `id`: the tools it used, what it's thinking, and the slides it has
 * written so far, in order.
 */
export function activityOf(messages: readonly SessionMessageInfo[], id: string, promptOf: (message: SessionMessageInfo) => unknown): Activity[] {
  const at = messages.findIndex((message) => message.type === "user" && promptOf(message) === id)
  if (at < 0) return []
  const next = messages.findIndex((message, index) => index > at && message.type === "user")
  const activity: Activity[] = []
  for (const message of messages.slice(at + 1, next < 0 ? undefined : next)) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "tool") activity.push({ kind: "tool", text: toolText(part.name, part.state.status === "streaming" ? undefined : part.state.input) })
      else if (part.type === "reasoning" && part.text.trim()) activity.push({ kind: "thinking", text: part.text.trim() })
      else if (part.type === "text") {
        // The deck's own title comes first; the rest are slides.
        const titles = [...part.text.matchAll(TITLE)].map((match) => { try { return JSON.parse(`"${match[1]}"`) as string } catch { return match[1]! } })
        for (const title of titles.slice(1)) activity.push({ kind: "slide", text: title })
      }
    }
  }
  return activity
}
