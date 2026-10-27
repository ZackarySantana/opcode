import { errorMessage } from "@opcode/core"
import { isInvalidRequestError, isSessionNotFoundError } from "@opencode/client"
import { createRefresh, type SetTimer, setTimer } from "@opcode/core/refresh"
import type { Context } from "@opencode/plugin/tui/context"
import { Identifier } from "@opencode/schema/identifier"
import { createSignal } from "solid-js"
import { formatReview } from "./message"
import {
  addComment, confirm, delivery, drafts, editComment, emptyReview, isViewed, markSent, moveComment, PLUGIN_ID, removeComment, toggleViewed, unconfirmed, unsend,
  type Anchor, type Delivery, type Mode, type Reply, type SessionReview,
} from "./review"
import { repliesRemote } from "./rpc"

type Saved = { sessions: Record<string, SessionReview> }

/** Where a session's panel was, so closing and reopening it (or a reload) lands on the same line and keeps a half-typed comment. */
export interface Position {
  readonly file?: string
  /** The cursor's line, as shown: new, or old for a removed row. */
  readonly line?: number
  readonly old?: boolean
  /** The cursor row's text, which it follows when lines move. */
  readonly text?: string
  /** A comment being written: a new one on its anchor, or the draft with this ID. */
  readonly editing?: { readonly id?: string; readonly anchor: Anchor; readonly text: string }
}

type Replies = (sessionID: string, directory: string, signal: AbortSignal) => Promise<Record<string, Reply>>

/**
 * The prompt's declared refusals that mean it was never admitted. A conflict is not one: another terminal may have
 * admitted the same ID, and a retry then returns that admission.
 */
const refused = (error: unknown) => isInvalidRequestError(error) || isSessionNotFoundError(error)

/** A user message ID in the host's own format, made here so a retry can reuse it. */
const messageID = (now: number) => `msg_${Identifier.create(false, now)}`

/**
 * Owns every session's comments and viewed files (synced across terminals), the agent's replies, and sending.
 * Panels come and go; this outlives them. Renders nothing.
 */
export class ReviewController {
  private readonly saved: Saved
  private readonly save: (mutation: (draft: Saved) => void) => Promise<void>
  private readonly positions: { sessions: Record<string, Position> }
  private readonly place: (mutation: (draft: { sessions: Record<string, Position> }) => void) => void
  private readonly replySignal = createSignal<Record<string, Record<string, Reply>>>({})
  private readonly inFlight = createSignal<ReadonlySet<string>>(new Set())
  private readonly focusSignal = createSignal(0)
  private readonly sending = new Map<string, Promise<void>>()
  private readonly replyReads = new Map<string, ReturnType<typeof createRefresh<Record<string, Reply>>>>()
  private readonly stops: (() => void)[] = []

  constructor(private readonly api: Pick<Context, "client" | "data" | "storage" | "ui" | "location">, private readonly replies: Replies = repliesRemote(api.client),
    readonly now: () => number = Date.now, readonly timer: SetTimer = setTimer) {
    ;[this.saved, this.save] = api.storage.store<Saved>("reviews", { initial: { sessions: {} } })
    ;[this.positions, this.place] = api.storage.memory<{ sessions: Record<string, Position> }>("positions", { initial: { sessions: {} } })
    // A message cancelled from the host's queue never reached the agent: its comments are drafts again.
    this.stops.push(api.data.on("session.inbox.cancelled", (event) => {
      if (this.review(event.data.sessionID).comments.some((comment) => comment.sent?.messageID === event.data.inboxID)) void this.change(event.data.sessionID, (review) => unsend(review, event.data.inboxID))
    }))
    // Replies arrive through a tool call, but tool events don't name the tool. Any finished tool in a session that was
    // sent comments schedules a read; the debounce folds a burst of tools into one.
    for (const type of ["session.tool.success", "session.idle"] as const) {
      this.stops.push(api.data.on(type, (event) => { if (this.review(event.data.sessionID).comments.some((comment) => comment.sent)) this.loadReplies(event.data.sessionID) }))
    }
  }

  review = (sessionID: string): SessionReview => this.saved.sessions[sessionID] ?? emptyReview
  repliesFor = (sessionID: string): Record<string, Reply> => this.replySignal[0]()[sessionID] ?? {}
  position = (sessionID: string): Position => this.positions.sessions[sessionID] ?? {}
  setPosition = (sessionID: string, position: Position) => this.place((draft) => { draft.sessions[sessionID] = position })

  /** Asks the open panel to take input, as /review does when the panel is already showing. */
  focusRequests = () => this.focusSignal[0]()
  requestFocus = () => this.focusSignal[1]((count) => count + 1)

  addComment = (sessionID: string, anchor: Anchor, text: string) => this.change(sessionID, (review) => addComment(review, anchor, text, this.now()))
  /** An emptied draft is deleted. */
  editComment = (sessionID: string, id: string, text: string) => this.change(sessionID, (review) => text ? editComment(review, id, text) : removeComment(review, id))
  moveComment = (sessionID: string, id: string, anchor: Anchor) => this.change(sessionID, (review) => moveComment(review, id, anchor))
  removeComment = (sessionID: string, id: string) => this.change(sessionID, (review) => removeComment(review, id))
  toggleViewed = (sessionID: string, mode: Mode, file: string, patch: string) => this.change(sessionID, (review) => toggleViewed(review, mode, file, patch))
  isViewed = (sessionID: string, mode: Mode, file: string, patch: string) => isViewed(this.review(sessionID), mode, file, patch)
  setView = (sessionID: string, mode: Mode, base?: string) => this.change(sessionID, (review) => ({ ...review, mode, base: base ?? review.base }))

  /** Each comment's delivery state, by ID. */
  deliveries(sessionID: string): ReadonlyMap<string, Delivery> {
    const pending = new Set(this.api.data.session.pending.list(sessionID).map((item) => item.id))
    const inFlight = this.inFlight[0]()
    return new Map(this.review(sessionID).comments.map((comment) => [comment.id, delivery(comment, pending, inFlight)]))
  }

  /** The session's directory, which picks the repository and the server location. */
  directory(sessionID: string): string | undefined {
    return this.api.data.session.get(sessionID)?.location.directory ?? this.api.location?.directory
  }

  loadReplies(sessionID: string): void {
    let reads = this.replyReads.get(sessionID)
    if (!reads) {
      reads = createRefresh(async (signal) => {
        const directory = this.directory(sessionID)
        return directory ? await this.replies(sessionID, directory, signal) : {}
      }, (state) => { if (state.value) this.replySignal[1]((all) => ({ ...all, [sessionID]: state.value! })) }, { timer: this.timer, delay: 250 })
      this.replyReads.set(sessionID, reads)
    }
    reads.schedule()
  }

  /** Whether anything is left to send: drafts, or a send the host never confirmed that isn't being retried now. */
  hasUnsent = (sessionID: string) => [...this.deliveries(sessionID).values()].some((state) => state === "draft" || state === "unconfirmed")

  /**
   * Sends the drafts as one message that steers the running agent, after retrying any earlier send the host never
   * confirmed under its original ID. Comments are marked sent before the request, and a press while a send is under
   * way joins it, so nothing goes twice.
   */
  send(sessionID: string, view: string): Promise<void> {
    const current = this.sending.get(sessionID)
    if (current) return current
    const sending = this.sendNow(sessionID, view).finally(() => this.sending.delete(sessionID))
    this.sending.set(sessionID, sending)
    return sending
  }

  private async sendNow(sessionID: string, view: string): Promise<void> {
    const pendingSends = unconfirmed(this.review(sessionID)).filter((group) => !this.inFlight[0]().has(group.messageID))
    const message = formatReview(drafts(this.review(sessionID)), view)
    if (!pendingSends.length && !message) return this.api.ui.toast.show({ title: "Review", message: "No draft comments to send." })
    const sends = pendingSends.flatMap((group) => {
      const retry = formatReview(group.comments, view)
      return retry ? [{ messageID: group.messageID, message: retry }] : []
    })
    if (message) {
      const id = messageID(this.now())
      await this.change(sessionID, (review) => markSent(review, message.ids, id, this.now()))
      sends.push({ messageID: id, message })
    }
    this.flight(sends.map((send) => send.messageID), true)
    let sent = 0
    let attempt: string | undefined
    try {
      for (const send of sends) {
        attempt = send.messageID
        await this.api.client.session.prompt({ sessionID, id: send.messageID, text: send.message.text, metadata: send.message.metadata, delivery: "steer" })
        await this.change(sessionID, (review) => confirm(review, send.messageID))
        sent += send.message.ids.length
      }
      this.api.ui.toast.show({ variant: "success", title: "Review", message: `Sent ${sent} ${sent === 1 ? "comment" : "comments"} to the agent.` })
    } catch (error) {
      const done = sent ? ` (${sent} sent)` : ""
      if (attempt && refused(error)) {
        // The host turned it down for good: a retry would fail the same way, so its comments are drafts again.
        await this.change(sessionID, (review) => unsend(review, attempt!))
        this.api.ui.toast.show({ variant: "error", title: "Review", message: `${errorMessage(error)}${done}. The comments are drafts again.` })
      } else {
        // It may still have been admitted; the next send retries it under the same ID, so it never arrives twice.
        this.api.ui.toast.show({ variant: "error", title: "Review", message: `${errorMessage(error)}${done}. Press S to retry.` })
      }
    } finally {
      this.flight(sends.map((send) => send.messageID), false)
    }
  }

  /** Applies a change to the stored review, as it stands when the store applies it, so changes in quick succession all land. */
  private change(sessionID: string, update: (review: SessionReview) => SessionReview): Promise<void> {
    return this.save((draft) => { draft.sessions[sessionID] = update(draft.sessions[sessionID] ?? emptyReview) }).catch((error) => {
      this.api.ui.toast.show({ variant: "error", title: "Review", message: `Couldn't save the review: ${errorMessage(error)}` })
    })
  }

  private flight(ids: readonly string[], on: boolean) {
    this.inFlight[1]((current) => {
      const next = new Set(current)
      for (const id of ids) on ? next.add(id) : next.delete(id)
      return next
    })
  }

  dispose(): void {
    for (const stop of this.stops) stop()
    for (const reads of this.replyReads.values()) reads.dispose()
  }
}
