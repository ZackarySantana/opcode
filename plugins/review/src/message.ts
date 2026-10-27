/** Review comments as one message to the agent. Knows nothing about the host. */

import { isQuestion, lineRange, PLUGIN_ID, type Comment } from "./review"

export const TOOL_NAME = "review_reply"

const QUOTE_LINES = 4
const TEXT_LIMIT = 20_000

function section(comment: Comment): string {
  const question = isQuestion(comment.text)
  const where = `${comment.file}:${lineRange(comment)}${comment.side === "old" ? " (removed lines)" : comment.outside ? " (outside the diff)" : ""}`
  const quote = comment.quote.slice(0, QUOTE_LINES).map((line) => `> ${line}`)
  if (comment.quote.length > QUOTE_LINES) quote.push(`> (${comment.quote.length - QUOTE_LINES} more lines)`)
  const text = question ? comment.text.replaceAll("??", "?") : comment.text
  return [`[${comment.id}] ${where}${question ? " [question]" : ""}`, ...quote, text.trim()].join("\n")
}

export interface ReviewMessage {
  readonly text: string
  /** The comments it carries, in order; any left out stay drafts for the next message. */
  readonly ids: readonly string[]
  readonly metadata: { [PLUGIN_ID]: { comments: string[] } }
}

/** The comments that fit, oldest first, under a short header that names the view and how to reply. */
export function formatReview(comments: readonly Comment[], view: string): ReviewMessage | undefined {
  const sections: string[] = []
  const ids: string[] = []
  let length = 0
  for (const comment of comments) {
    const text = section(comment)
    length += text.length + 2
    // The first always goes, however long, so one comment can't block the rest forever.
    if (sections.length && length > TEXT_LIMIT) break
    sections.push(text)
    ids.push(comment.id)
  }
  if (!ids.length) return undefined
  const questions = comments.some((comment) => ids.includes(comment.id) && isQuestion(comment.text))
  const header = [
    `Review comments on your changes (${view}). Line numbers are from the diff I'm looking at.`,
    `Address each, then reply once with ${TOOL_NAME}: done if you changed the code, answered for a question, declined with why. One sentence each.`,
    ...questions ? ["[question] comments want an answer, not an edit."] : [],
  ]
  return { text: `${header.join("\n")}\n\n${sections.join("\n\n")}`, ids, metadata: { [PLUGIN_ID]: { comments: [...ids] } } }
}
