import { errorMessage } from "@opcode/core"
import type { Context } from "@opencode/plugin/tui/context"
import { answerOf, promptMetadata, promptOf, type Answer } from "./ask"
import { activityOf, guidePrompt, type Activity, type Deck } from "./guide"
import type { Helpers } from "./helper"

/** A reviewed session's guided review: the prompt that asked for it, its deck once written, and the slide you're on. */
export interface GuideRun {
  readonly id: string
  /** The helper writing it, once the prompt reached it. */
  readonly session?: string
  /** The view it presents, as its header names it. */
  readonly view: string
  readonly slide: number
  readonly error?: string
  /** The deck, read from the finished answer against the diff as it was then; its code follows its lines after. */
  readonly deck?: Deck
  /** The finished answer had no deck in it. */
  readonly unreadable?: boolean
}

export type GuideFiles = readonly { file: string; patch: string; additions: number; deletions: number }[]

/**
 * Guided reviews, written by the conversation's model in the reviewed session's helper: the diff presented as a
 * short slide deck. One per reviewed session, kept until it's started over or the terminal exits.
 */
export class Guides {
  private readonly state: { sessions: Record<string, GuideRun> }
  private readonly set: (mutation: (draft: { sessions: Record<string, GuideRun> }) => void) => void

  constructor(api: Pick<Context, "storage">, private readonly helpers: Helpers) {
    ;[this.state, this.set] = api.storage.memory<{ sessions: Record<string, GuideRun> }>("guides", { initial: { sessions: {} } })
  }

  run = (sessionID: string): GuideRun | undefined => this.state.sessions[sessionID]
  model = (sessionID: string): string | undefined => this.helpers.model(sessionID)
  /** The answer so far, streaming while the model writes. */
  answer = (run: GuideRun): Answer => answerOf(run.session ? this.helpers.transcript(run.session) : [], run)
  /** What the model has done so far, for the live log. */
  activity = (run: GuideRun): Activity[] => run.session ? activityOf(this.helpers.transcript(run.session), run.id, promptOf) : []
  /** Still being written: neither a deck nor a failure yet. */
  writing = (run: GuideRun) => !run.deck && !run.unreadable && !run.error && this.answer(run).state !== "failed"

  /** Starts a new guided review of the files' changes, replacing any earlier one. */
  async start(sessionID: string, directory: string, view: string, files: GuideFiles): Promise<void> {
    if (this.run(sessionID)) await this.stop(sessionID)
    const id = this.helpers.id()
    this.set((draft) => { draft.sessions[sessionID] = { id, view, slide: 0 } })
    try {
      const helper = await this.helpers.send(sessionID, directory, { id, kind: "guide", metadata: promptMetadata(id), text: () => guidePrompt({ view, files }) })
      this.update(sessionID, id, (run) => ({ ...run, session: helper }))
    } catch (error) {
      this.update(sessionID, id, (run) => ({ ...run, error: errorMessage(error) }))
    }
  }

  setSlide = (sessionID: string, slide: number) => { const run = this.run(sessionID); if (run) this.update(sessionID, run.id, (current) => ({ ...current, slide })) }
  /** Keeps the deck read from the finished answer, or notes there was none. */
  settle = (sessionID: string, id: string, deck: Deck | undefined) =>
    this.update(sessionID, id, (run) => deck ? { ...run, deck, slide: 0 } : { ...run, unreadable: true })

  /** Drops the guide, stopping it if it's still being written. */
  async stop(sessionID: string): Promise<void> {
    const run = this.run(sessionID)
    if (!run) return
    const state = this.answer(run).state
    this.set((draft) => { delete draft.sessions[sessionID] })
    if (!run.session) return
    if (state === "waiting") await this.helpers.cancel(run.session, run.id, "waiting")
    else if (state === "thinking" || state === "answering") await this.helpers.cancel(run.session, run.id, "working")
  }

  /** Changes the run with this ID, if it's still the session's. */
  private update(sessionID: string, id: string, update: (run: GuideRun) => GuideRun) {
    this.set((draft) => { const run = draft.sessions[sessionID]; if (run?.id === id) draft.sessions[sessionID] = update(run) })
  }
}
