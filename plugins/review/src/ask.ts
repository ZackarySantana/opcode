/**
 * Questions about the diff, answered by the conversation's model in a session of their own: the prompt each one sends, and
 * each answer as that session's messages tell it. Knows nothing about the host.
 */

import type { SessionMessageInfo } from "@opencode/client"
import { lineOf, MARK, type Row } from "./patch"
import { lineRange, PLUGIN_ID, type Anchor } from "./review"

/** A question asked about some lines: shown under them until dismissed. */
export interface Ask {
  /** Also tags the prompt, which finds its answer among the session's messages. */
  readonly id: string
  readonly anchor: Anchor
  readonly question: string
  /** The session answering it, once it's made. */
  readonly session?: string
  /** Set when the question never reached the session. */
  readonly error?: string
}

export type AnswerState = "waiting" | "thinking" | "answering" | "done" | "failed"

export interface Answer {
  readonly state: AnswerState
  readonly text: string
  /** The tools the model used to look around, such as read, in order. */
  readonly looked: readonly string[]
  readonly error?: string
}

/** What the answering session may do: read and search the code, nothing else. A hidden session can't ask you for permission. */
export const ASK_PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
] as const

/** Rows of the diff around a question, at most this many on each side of it. */
const AROUND = 30

/** The diff rows around the asked ones, numbered, with the asked rows marked by `>`. */
export function excerpt(rows: readonly Row[], from: number, to: number): string {
  const start = Math.max(0, from - AROUND)
  const end = Math.min(rows.length - 1, to + AROUND)
  const lines: string[] = []
  for (let index = start; index <= end; index++) {
    const row = rows[index]!
    if (index > start && rows[index - 1]!.hunk !== row.hunk) lines.push("   ⋯")
    lines.push(`${index >= from && index <= to ? ">" : " "}${String(lineOf(row)).padStart(5)} ${MARK[row.kind]}${row.text}`)
  }
  return lines.join("\n")
}

const INSTRUCTIONS = [
  "I'm reviewing changes an agent made in this repository, and I have questions about specific lines.",
  "Answer each question briefly and directly, in plain text: a few sentences, or a short list when that's clearer. No headings.",
  "You can read and search the repository to check callers, definitions, or tests before answering. Don't edit anything.",
  "Line numbers are the file's, after the change. In excerpts, + is an added line, - a removed one, and > marks the lines I'm asking about.",
].join("\n")

/** The prompt for a question. The first one in a session also says what the session is for. */
export function askPrompt(input: { anchor: Anchor; question: string; excerpt: string; view: string; files: readonly string[]; first: boolean }): string {
  const { anchor } = input
  const where = `${anchor.file}:${lineRange(anchor)}${anchor.side === "old" ? " (removed lines)" : anchor.outside ? " (not part of the change)" : ""}`
  const context = input.first && input.files.length
    ? [`The change (${input.view}) touches: ${input.files.slice(0, 50).join(", ")}${input.files.length > 50 ? `, and ${input.files.length - 50} more` : ""}.`]
    : []
  return [
    ...input.first ? [INSTRUCTIONS, ...context, ""] : [],
    `About ${where}:`,
    "```",
    input.excerpt,
    "```",
    "",
    input.question.trim(),
  ].join("\n")
}

/** Metadata that tags a question's prompt, so its user message can be found again. */
export const askMetadata = (id: string) => ({ [PLUGIN_ID]: { ask: id } })
const askOf = (message: SessionMessageInfo) => (message.metadata?.[PLUGIN_ID] as { ask?: unknown } | undefined)?.ask

/**
 * A question's answer, from the answering session's messages: what the model wrote after the question and before
 * the next one. `running` is whether the session is working now; the latest question is the one it works on.
 */
export function answerOf(messages: readonly SessionMessageInfo[], ask: Ask, running: boolean): Answer {
  if (ask.error) return { state: "failed", text: "", looked: [], error: ask.error }
  const at = messages.findIndex((message) => message.type === "user" && askOf(message) === ask.id)
  if (at < 0) return { state: "waiting", text: "", looked: [] }
  const next = messages.findIndex((message, index) => index > at && message.type === "user")
  const replies = messages.slice(at + 1, next < 0 ? undefined : next).flatMap((message) => message.type === "assistant" ? [message] : [])
  const parts = replies.flatMap((message) => message.content)
  // Text before a tool call is the model thinking aloud; the answer is what it wrote after its last look around.
  let lastTool = -1
  parts.forEach((part, index) => { if (part.type === "tool") lastTool = index })
  const text = parts.slice(lastTool + 1).flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim()
  const looked = parts.flatMap((part) => part.type === "tool" ? [part.name] : [])
  const error = [...replies].reverse().find((message) => message.error)?.error
  const working = running && next < 0
  if (working) return { state: text ? "answering" : "thinking", text, looked }
  if (error && !text) return { state: "failed", text, looked, error: error.message }
  // Done is only known once the session stops, or moves on to the next question.
  return { state: replies.length ? "done" : "thinking", text, looked }
}
