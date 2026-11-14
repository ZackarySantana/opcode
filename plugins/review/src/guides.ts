import { errorMessage } from "@opcode/core"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { answerOf, promptMetadata, type Answer } from "./ask"
import { guidePrompt, type Guide } from "./guide"
import type { Helpers } from "./helper"

/** A reviewed session's guided review: the prompt that asked for it, and where you are in it. */
export interface GuideRun {
  readonly id: string
  /** The helper writing it, once the prompt reached it. */
  readonly session?: string
  /** The view it walks through, as its header names it. */
  readonly view: string
  /** The step you're on. */
  readonly step: number
  /** Whether the panel is walking through it, rather than reviewing freely. */
  readonly active: boolean
  readonly error?: string
  /** The steps, read from the finished answer against the diff as it was then; they follow their lines after. */
  readonly guide?: Guide
  /** The finished answer had no guide in it. */
  readonly unreadable?: boolean
}

/**
 * Guided reviews, written by the conversation's model in the reviewed session's helper: a walk through the diff in
 * the order that explains it. One per reviewed session, kept until it's started over or the terminal exits.
 */
export class Guides {
  private readonly state: { sessions: Record<string, GuideRun> }
  private readonly set: (mutation: (draft: { sessions: Record<string, GuideRun> }) => void) => void
  private readonly requested = createSignal(false)

  constructor(api: Pick<Context, "storage">, private readonly helpers: Helpers) {
    ;[this.state, this.set] = api.storage.memory<{ sessions: Record<string, GuideRun> }>("guides", { initial: { sessions: {} } })
  }

  run = (sessionID: string): GuideRun | undefined => this.state.sessions[sessionID]
  model = (sessionID: string): string | undefined => this.helpers.model(sessionID)
  /** What the model wrote so far, streaming while it writes. */
  answer = (run: GuideRun): Answer => answerOf(run.session ? this.helpers.transcript(run.session) : [], run)

  /** Asks the panel to walk through its view, as /diffs-guided does: resuming a guide, or starting one. It waits for the panel. */
  request = () => this.requested[1](true)
  pending = () => this.requested[0]()
  /** The panel takes the request it's handling. */
  take = () => this.requested[1](false)

  /** Starts a new guided review of the files' changes, replacing any earlier one. */
  async start(sessionID: string, directory: string, view: string, files: readonly { file: string; patch: string; additions: number; deletions: number }[]): Promise<void> {
    const earlier = this.run(sessionID)
    if (earlier) await this.stop(sessionID)
    const id = this.helpers.id()
    this.update(sessionID, () => ({ id, view, step: 0, active: true }))
    try {
      const helper = await this.helpers.send(sessionID, directory, { id, kind: "guide", metadata: promptMetadata(id), text: () => guidePrompt({ view, files }) })
      this.update(sessionID, (run) => run.id === id ? { ...run, session: helper } : run)
    } catch (error) {
      this.update(sessionID, (run) => run.id === id ? { ...run, error: errorMessage(error) } : run)
    }
  }

  /** Walks through the guide again, or stops, keeping your place. */
  setActive = (sessionID: string, active: boolean) => this.update(sessionID, (run) => ({ ...run, active }))
  setStep = (sessionID: string, step: number) => this.update(sessionID, (run) => ({ ...run, step }))
  /** Keeps the guide read from the finished answer, or notes there was none. */
  settle = (sessionID: string, id: string, guide: Guide | undefined) =>
    this.update(sessionID, (run) => run.id !== id ? run : guide ? { ...run, guide, step: 0 } : { ...run, unreadable: true })

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

  private update(sessionID: string, update: (run: GuideRun) => GuideRun) {
    this.set((draft) => {
      const current = draft.sessions[sessionID]
      const next = current ? update(current) : update({ id: "", view: "", step: 0, active: false })
      if (next.id) draft.sessions[sessionID] = next
    })
  }
}
