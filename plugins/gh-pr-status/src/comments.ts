/** Review feedback on a pull request, chosen and formatted for the agent. Knows nothing about gh or the host. */

export interface Comment {
  /** "ghost" when GitHub no longer knows who wrote it. */
  readonly author: string
  readonly bot: boolean
  readonly body: string
  readonly url: string
}

/** GitHub's review thread. Lines are null when it no longer applies to the diff, or for a comment on the whole file. */
export interface Thread {
  readonly isResolved: boolean
  readonly isOutdated: boolean
  readonly path: string
  readonly line: number | null
  readonly startLine: number | null
  readonly originalLine: number | null
  readonly originalStartLine: number | null
  /** The diff the thread started on. */
  readonly diffHunk?: string
  readonly comments: readonly Comment[]
}

export interface Review extends Comment {
  /** Such as "APPROVED", "CHANGES_REQUESTED", or "COMMENTED". */
  readonly state: string
}

export interface Feedback {
  readonly viewer: string
  readonly pr: { readonly number: number; readonly title: string; readonly url: string; readonly branch: string }
  readonly threads: readonly Thread[]
  readonly reviews: readonly Review[]
  readonly comments: readonly Comment[]
}

export const DEFAULT_PROMPT = "The branch {branch} got reviewed by one of our coworkers. We want to verify each comment before thinking about what type of change it would be. Look at the bigger picture. After reviewing each comment and the relevant code paths, get back to the user with an actionable item for each comment. An action could be replying why not to do the comment, recommending to change the code and how that changes it from a feature perspective, or recommending to change the code and how it fixes a correctness issue."

const BODY_LIMIT = 1500
const TEXT_LIMIT = 40_000
const HUNK_LINES = 4
/** Longer threads keep the first comment and the last few replies. */
const TAIL = 3

const clip = (comment: Comment) => {
  const body = comment.body.replace(/\r\n/g, "\n").trim()
  return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}... (truncated, ${comment.url})` : body
}

function anchor(thread: Thread): string {
  const range = (start: number | null, end: number) => start !== null && start !== end ? `${start}-${end}` : `${end}`
  if (thread.isOutdated && thread.originalLine !== null) return `${thread.path} (outdated; was line ${range(thread.originalStartLine, thread.originalLine)})`
  if (thread.line !== null) return `${thread.path}:${range(thread.startLine, thread.line)}`
  return thread.path
}

const list = (parts: readonly [number, string][]) => parts.filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join(", ")

/**
 * Feedback from others the agent should act on: unresolved threads started by someone else (outdated ones included),
 * plus their review summaries and pull request comments. Bots and your own threads, summaries, and comments are left
 * out; your replies in someone else's thread stay. Undefined `text` means nothing is left to send.
 */
export function formatFeedback(feedback: Feedback, template = DEFAULT_PROMPT): { text?: string; summary: string } {
  const viewer = feedback.viewer.toLowerCase()
  const yours = (comment: Comment) => comment.author.toLowerCase() === viewer
  const who = (comment: Comment) => yours(comment) ? "you" : comment.author
  const dropped = { resolved: 0, yours: 0, bot: 0, length: 0 }
  const others = (comment: Comment) => {
    if (!comment.body.trim()) return false
    if (comment.bot) dropped.bot++
    else if (yours(comment)) dropped.yours++
    else return true
    return false
  }

  const sections: { kind: "thread" | "review" | "comment"; text: string }[] = []
  for (const thread of feedback.threads) {
    const [first, ...rest] = thread.comments
    if (!first) continue
    if (thread.isResolved) { dropped.resolved++; continue }
    if (first.bot) { dropped.bot++; continue }
    if (yours(first)) { dropped.yours++; continue }
    const replies = rest.filter((comment) => !comment.bot)
    dropped.bot += rest.length - replies.length
    const omitted = replies.slice(0, -TAIL)
    const lines = [first, ...replies.slice(omitted.length)].map((comment) => `${who(comment)}: ${clip(comment)}`)
    if (omitted.length) lines.splice(1, 0, `(${omitted.length} ${omitted.length === 1 ? "reply" : "replies"} omitted, ${omitted[0]!.url})`)
    const hunk = thread.isOutdated && thread.diffHunk ? `\`\`\`diff\n${thread.diffHunk.split("\n").slice(-HUNK_LINES).join("\n")}\n\`\`\`\n` : ""
    sections.push({ kind: "thread", text: `${anchor(thread)} ${first.url}\n${hunk}${lines.join("\n")}` })
  }
  for (const review of feedback.reviews.filter((review) => review.state !== "PENDING" && others(review))) {
    sections.push({ kind: "review", text: `Review by ${review.author} (${review.state.toLowerCase().replace("_", " ")}) ${review.url}\n${clip(review)}` })
  }
  for (const comment of feedback.comments.filter(others)) sections.push({ kind: "comment", text: `Comment by ${comment.author} ${comment.url}\n${clip(comment)}` })

  // Whole sections, in order, until the text would pass its limit.
  const kept: typeof sections = []
  let length = 0
  for (const [index, section] of sections.entries()) {
    const text = `## ${index + 1}. ${section.text}`
    if ((length += text.length + 2) > TEXT_LIMIT) break
    kept.push({ ...section, text })
  }
  dropped.length = sections.length - kept.length
  const included = list((["thread", "review", "comment"] as const).map((kind) => {
    const count = kept.filter((section) => section.kind === kind).length
    return [count, `${kind}${count === 1 ? "" : "s"}`]
  })) || "nothing"
  const left = list([[dropped.resolved, "resolved"], [dropped.yours, "yours"], [dropped.bot, "from bots"], [dropped.length, "over the length limit"]])
  const summary = `Included ${included}${left ? `; left out ${left}` : ""}.`
  if (!kept.length) return { summary }
  const { pr } = feedback
  const prompt = template.replaceAll("{branch}", pr.branch).replaceAll("{pr}", String(pr.number))
  return { summary, text: `${prompt}\n\nPR #${pr.number}: ${pr.title}\n${pr.url}\n${summary}\n\n${kept.map((section) => section.text).join("\n\n")}` }
}
