/** A session's review: comments anchored to diff lines, their delivery, and which files were viewed. Knows nothing about the host. */

import { hashText, lineOf, MARK, type Row } from "./patch"

export const PLUGIN_ID = "opcode-review"

export type Mode = "turn" | "session" | "working" | "branch"
export const modes: readonly Mode[] = ["turn", "session", "working", "branch"]
export const modeTitle: Record<Mode, string> = { turn: "This turn", session: "Session", working: "Uncommitted", branch: "Branch" }

/** How the changed files are listed: as a folder tree, or as full paths. */
export type FileList = "tree" | "paths"
export interface Settings {
  readonly fileList: FileList
}
export const defaultSettings: Settings = { fileList: "tree" }

export type Side = "new" | "old"
export type ReplyStatus = "done" | "answered" | "declined"
export const replyStatuses: readonly ReplyStatus[] = ["done", "answered", "declined"]

/** Where a comment sits: its file, lines, and the text of those lines. */
export interface Anchor {
  readonly file: string
  /** Lines on the new side, or the old side when every line is a removed one. */
  readonly side: Side
  readonly start: number
  readonly end: number
  /** The commented rows, each with its diff sign, to find them again after the lines move. */
  readonly quote: readonly string[]
}

export interface Comment extends Anchor {
  /** Short and per session, like r3, so the agent can name it in a reply. */
  readonly id: string
  readonly text: string
  readonly created: number
  /** The message carrying it. Until the host confirms it, sending again reuses the same ID, so the agent never gets it twice. */
  readonly sent?: { readonly messageID: string; readonly at: number; readonly confirmed: boolean }
}

export interface Reply {
  readonly status: ReplyStatus
  readonly reply: string
  readonly at: number
}

export interface SessionReview {
  readonly next: number
  readonly comments: readonly Comment[]
  /** Patch hash per mode and file, as last marked viewed. */
  readonly viewed: Readonly<Record<string, string>>
  readonly mode: Mode
  readonly base?: string
}

export const emptyReview: SessionReview = { next: 1, comments: [], viewed: {}, mode: "turn" }

/** "??" anywhere marks a question: the agent should answer it, not edit. */
export const isQuestion = (text: string) => text.includes("??")

/** "41", or "41-44" for a range. */
export const lineRange = (anchor: Anchor) => anchor.start === anchor.end ? `${anchor.start}` : `${anchor.start}-${anchor.end}`

/** Where a comment on rows `from`..`to` (inclusive, either order) lands: new-side lines when any row has one. */
export function anchorOf(file: string, rows: readonly Row[], from: number, to: number): Anchor {
  const picked = rows.slice(Math.min(from, to), Math.max(from, to) + 1)
  const news = picked.flatMap((row) => row.new === undefined || row.kind === "del" ? [] : [row.new])
  const side: Side = news.length ? "new" : "old"
  const lines = news.length ? news : picked.map((row) => row.old!)
  return { file, side, start: Math.min(...lines), end: Math.max(...lines), quote: picked.map((row) => MARK[row.kind] + row.text) }
}

/**
 * The rows a comment covers in the current diff of its file: where its quoted text appears, nearest its line, or
 * undefined when the text is gone from this view. Only the text is compared, so a line that stopped being new still matches.
 */
export function locate(anchor: Anchor, rows: readonly Row[]): { from: number; to: number } | undefined {
  const quote = anchor.quote.map((line) => line.slice(1))
  if (!quote.length) return undefined
  let best: { from: number; distance: number } | undefined
  for (let from = 0; from + quote.length <= rows.length; from++) {
    if (!quote.every((text, offset) => rows[from + offset]!.text === text)) continue
    const row = rows[from]!
    const line = anchor.side === "new" ? row.new ?? row.newAt : row.old ?? row.oldAt
    const distance = Math.abs(line - anchor.start)
    if (!best || distance < best.distance) best = { from, distance }
  }
  return best && { from: best.from, to: best.from + quote.length - 1 }
}

/** The comments on a file, each with the rows it covers in this diff, or none when its text is gone from it. */
export const placeComments = (comments: readonly Comment[], rows: readonly Row[]) => comments.map((comment) => ({ comment, at: locate(comment, rows) }))

/**
 * The row a cursor kept as a line and its text lands on: that text nearest the line, so it follows its line when
 * rows are added above; else the row showing that line (an old line when `old`), else the nearest one.
 */
export function nearestRow(rows: readonly Row[], line: number | undefined, old = false, text?: string): number {
  if (!rows.length || line === undefined) return 0
  const closest = (indices: readonly number[]) => indices.reduce((best, index) => Math.abs(lineOf(rows[index]!) - line) < Math.abs(lineOf(rows[best]!) - line) ? index : best)
  const same = rows.flatMap((row, index) => row.text === text && (row.kind === "del") === old ? [index] : [])
  if (same.length) return closest(same)
  const exact = rows.findIndex((row) => lineOf(row) === line && (row.kind === "del") === old)
  return exact >= 0 ? exact : closest(rows.map((_, index) => index))
}

const viewedKey = (mode: Mode, file: string) => `${mode}:${file}`

/** A file stays viewed until its patch changes. */
export const isViewed = (review: SessionReview, mode: Mode, file: string, patch: string) => review.viewed[viewedKey(mode, file)] === hashText(patch)

export const drafts = (review: SessionReview) => review.comments.filter((comment) => !comment.sent)

export type Delivery = "draft" | "sending" | "unconfirmed" | "pending" | "sent"

/** Sent comments wait in the session inbox until the agent takes them. An unconfirmed send is retried by the next one. */
export function delivery(comment: Comment, pending: ReadonlySet<string>, inFlight: ReadonlySet<string>): Delivery {
  if (!comment.sent) return "draft"
  if (inFlight.has(comment.sent.messageID)) return "sending"
  if (!comment.sent.confirmed) return "unconfirmed"
  return pending.has(comment.sent.messageID) ? "pending" : "sent"
}

/** Messages whose admission was never confirmed, oldest first, with the comments each carries. */
export function unconfirmed(review: SessionReview): { messageID: string; comments: Comment[] }[] {
  const groups = new Map<string, Comment[]>()
  for (const comment of review.comments) {
    if (comment.sent && !comment.sent.confirmed) groups.set(comment.sent.messageID, [...groups.get(comment.sent.messageID) ?? [], comment])
  }
  return [...groups].map(([messageID, comments]) => ({ messageID, comments }))
}

export function addComment(review: SessionReview, anchor: Anchor, text: string, now: number): SessionReview {
  const comment: Comment = { id: `r${review.next}`, ...anchor, text, created: now }
  return { ...review, next: review.next + 1, comments: [...review.comments, comment] }
}

/** Only drafts change: what was sent is what the agent read. */
export function editComment(review: SessionReview, id: string, text: string): SessionReview {
  return { ...review, comments: review.comments.map((comment) => comment.id === id && !comment.sent ? { ...comment, text } : comment) }
}

/** A draft whose text moved takes its new lines, so the message names the lines the agent sees. */
export function moveComment(review: SessionReview, id: string, anchor: Anchor): SessionReview {
  return { ...review, comments: review.comments.map((comment) => comment.id === id && !comment.sent ? { ...comment, ...anchor } : comment) }
}

export function removeComment(review: SessionReview, id: string): SessionReview {
  return { ...review, comments: review.comments.filter((comment) => comment.id !== id || !!comment.sent) }
}

export function markSent(review: SessionReview, ids: readonly string[], messageID: string, at: number): SessionReview {
  const chosen = new Set(ids)
  return { ...review, comments: review.comments.map((comment) => chosen.has(comment.id) && !comment.sent ? { ...comment, sent: { messageID, at, confirmed: false } } : comment) }
}

export function confirm(review: SessionReview, messageID: string): SessionReview {
  return { ...review, comments: review.comments.map((comment) => comment.sent?.messageID === messageID ? { ...comment, sent: { ...comment.sent, confirmed: true } } : comment) }
}

/** A message that never reached the agent (cancelled, or refused) returns its comments to the drafts. */
export function unsend(review: SessionReview, messageID: string): SessionReview {
  return { ...review, comments: review.comments.map(({ sent, ...comment }) => sent && sent.messageID !== messageID ? { ...comment, sent } : comment) }
}

export function toggleViewed(review: SessionReview, mode: Mode, file: string, patch: string): SessionReview {
  const key = viewedKey(mode, file)
  const { [key]: _, ...rest } = review.viewed
  return { ...review, viewed: isViewed(review, mode, file, patch) ? rest : { ...rest, [key]: hashText(patch) } }
}
