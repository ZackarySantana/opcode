import { errorMessage } from "@opcode/core"
import type { Context } from "@opencode/plugin/tui/context"
import { answerOf, promptMetadata, askPrompt, type Answer, type Ask } from "./ask"
import type { Helpers } from "./helper"
import type { Anchor } from "./review"

/** What a question is about, besides its lines: the diff around them, the view, and the files it changes. */
export interface AskContext {
  readonly excerpt: string
  readonly view: string
  readonly files: readonly string[]
}

/**
 * Asks the conversation's model about lines of the diff, in the reviewed session's helper, without the agent seeing
 * it. Follow-ups share the helper, so they keep their context. Questions last until dismissed or the terminal exits.
 */
export class Asks {
  private readonly state: { sessions: Record<string, readonly Ask[]> }
  private readonly set: (mutation: (draft: { sessions: Record<string, readonly Ask[]> }) => void) => void

  constructor(api: Pick<Context, "storage">, private readonly helpers: Helpers) {
    ;[this.state, this.set] = api.storage.memory<{ sessions: Record<string, readonly Ask[]> }>("asks", { initial: { sessions: {} } })
  }

  list = (sessionID: string): readonly Ask[] => this.state.sessions[sessionID] ?? []
  model = (sessionID: string): string | undefined => this.helpers.model(sessionID)

  /** A question's answer as it stands, streaming while the model writes it. */
  answer = (ask: Ask): Answer => answerOf(ask.session ? this.helpers.transcript(ask.session) : [], ask)

  /** Asks about the anchored lines. The card shows at once; the answer streams into it. */
  async ask(sessionID: string, directory: string, anchor: Anchor, question: string, context: AskContext): Promise<void> {
    const id = this.helpers.id()
    // A plain copy: the anchor may be a live object of another store.
    const { file, side, start, end, quote, outside } = anchor
    const kept: Anchor = { file, side, start, end, quote: [...quote], ...outside ? { outside } : {} }
    this.update(sessionID, (asks) => [...asks, { id, anchor: kept, question }])
    try {
      const helper = await this.helpers.send(sessionID, directory, {
        id, kind: "ask", metadata: promptMetadata(id),
        text: (intro) => askPrompt({ anchor: kept, question, ...context, first: intro }),
      })
      this.update(sessionID, (asks) => asks.map((item) => item.id === id ? { ...item, session: helper } : item))
    } catch (error) {
      this.update(sessionID, (asks) => asks.map((item) => item.id === id ? { ...item, error: errorMessage(error) } : item))
    }
  }

  /** Hides a question's card, and stops its answer when it's still coming. */
  async dismiss(sessionID: string, id: string): Promise<void> {
    const ask = this.list(sessionID).find((item) => item.id === id)
    if (!ask) return
    const state = this.answer(ask).state
    this.update(sessionID, (asks) => asks.filter((item) => item.id !== id))
    if (!ask.session) return
    if (state === "waiting") await this.helpers.cancel(ask.session, id, "waiting")
    else if (state === "thinking" || state === "answering") await this.helpers.cancel(ask.session, id, "working")
  }

  private update(sessionID: string, update: (asks: readonly Ask[]) => readonly Ask[]) {
    this.set((draft) => { draft.sessions[sessionID] = update(draft.sessions[sessionID] ?? []) })
  }
}
