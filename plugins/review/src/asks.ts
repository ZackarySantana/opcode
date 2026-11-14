import { errorMessage } from "@opcode/core"
import { sideSessionMetadata } from "@opcode/core/side"
import type { ModelRef } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import { Identifier } from "@opencode/schema/identifier"
import { answerOf, ASK_PERMISSIONS, askMetadata, askPrompt, pickModel, type Answer, type Ask } from "./ask"
import { PLUGIN_ID, type Anchor } from "./review"

/** A reviewed session's questions, and the session of its own that answers them. */
interface Questions {
  /** The answering session, once it exists. */
  readonly sessionID?: string
  /** The answering model's name, for the cards. */
  readonly model?: string
  readonly items: readonly Ask[]
}

/** What a question is about, besides its lines: the diff around them, the view, and the files it changes. */
export interface AskContext {
  readonly excerpt: string
  readonly view: string
  readonly files: readonly string[]
}

type Api = Pick<Context, "client" | "data" | "storage" | "ui">

/**
 * Asks a small model about lines of the diff. Each reviewed session gets one answering session, made on the first
 * question and archived so it stays out of the session lists, which keeps follow-ups in context and its usage
 * recorded like any session's. Questions last until dismissed or the terminal exits; they never reach the agent.
 */
export class Asks {
  private readonly state: { sessions: Record<string, Questions> }
  private readonly set: (mutation: (draft: { sessions: Record<string, Questions> }) => void) => void
  /** The answering session being made for a reviewed session, so quick questions share it. */
  private readonly opening = new Map<string, Promise<string>>()

  constructor(private readonly api: Api, private readonly now: () => number) {
    ;[this.state, this.set] = api.storage.memory<{ sessions: Record<string, Questions> }>("asks", { initial: { sessions: {} } })
  }

  list = (sessionID: string): readonly Ask[] => this.state.sessions[sessionID]?.items ?? []
  model = (sessionID: string): string | undefined => this.state.sessions[sessionID]?.model

  /** A question's answer as it stands, streaming while the model writes it. */
  answer(sessionID: string, ask: Ask): Answer {
    const answering = this.state.sessions[sessionID]?.sessionID
    if (!answering) return answerOf([], ask, false)
    return answerOf(this.api.data.session.message.list(answering), ask, this.api.data.session.status(answering) === "running")
  }

  /** Asks about the anchored lines. The card shows at once; the answer streams into it. */
  async ask(sessionID: string, directory: string, anchor: Anchor, question: string, context: AskContext): Promise<void> {
    const id = `msg_${Identifier.create(false, this.now())}`
    // A plain copy: the anchor may be a live object of another store.
    const { file, side, start, end, quote, outside } = anchor
    const kept: Anchor = { file, side, start, end, quote: [...quote], ...outside ? { outside } : {} }
    this.update(sessionID, (questions) => ({ ...questions, items: [...questions.items, { id, anchor: kept, question }] }))
    try {
      const existing = this.state.sessions[sessionID]?.sessionID
      const answering = existing ?? await this.open(sessionID, directory)
      const text = askPrompt({ anchor: kept, question, ...context, first: !existing })
      await this.api.client.session.prompt({ sessionID: answering, id, text, metadata: askMetadata(id), delivery: "queue" })
    } catch (error) {
      this.change(sessionID, id, { error: errorMessage(error) })
    }
  }

  /** Hides a question's card, and stops its answer when it's the one being worked on. */
  async dismiss(sessionID: string, id: string): Promise<void> {
    const questions = this.state.sessions[sessionID]
    const ask = questions?.items.find((item) => item.id === id)
    if (!questions || !ask) return
    const answer = this.answer(sessionID, ask)
    this.update(sessionID, (current) => ({ ...current, items: current.items.filter((item) => item.id !== id) }))
    const answering = questions.sessionID
    if (!answering) return
    try {
      if (answer.state === "waiting") await this.api.client.session.inbox.cancel({ sessionID: answering, inboxID: id })
      // A later question waiting behind it would be stopped too, so only the last one is interrupted.
      else if ((answer.state === "thinking" || answer.state === "answering") && questions.items.at(-1)?.id === id) await this.api.client.session.interrupt({ sessionID: answering })
    } catch {
      // It may have finished in the meantime; the card is gone either way.
    }
  }

  private open(sessionID: string, directory: string): Promise<string> {
    let opening = this.opening.get(sessionID)
    if (!opening) {
      opening = this.create(sessionID, directory).finally(() => this.opening.delete(sessionID))
      this.opening.set(sessionID, opening)
    }
    return opening
  }

  private async create(sessionID: string, directory: string): Promise<string> {
    const location = { directory }
    const { model, name } = await this.pick(location)
    const parent = this.api.data.session.get(sessionID)?.title
    const session = await this.api.client.session.create({
      title: parent ? `Review questions: ${parent}` : "Review questions",
      location, permissions: [...ASK_PERMISSIONS], metadata: sideSessionMetadata({ parentID: sessionID, plugin: PLUGIN_ID }),
      ...model ? { model } : {},
    })
    // Archived sessions stay out of the session lists and pickers.
    await this.api.client.session.update({ sessionID: session.id, archived: true })
    // The host streams a session's messages into its store once they've been read.
    await this.api.data.session.message.sync(session.id)
    this.update(sessionID, (questions) => ({ ...questions, sessionID: session.id, model: name }))
    return session.id
  }

  /** The configured small model, or OpenCode's small model for the default provider, with its name. */
  private async pick(location: { directory: string }): Promise<{ model?: ModelRef; name?: string }> {
    const [title, fallback, models] = await Promise.all([
      this.api.client.agent.get({ agentID: "title", location }).then((result) => result.data.model, () => undefined),
      this.api.client.model.default({ location }).then((result) => result.data ?? undefined, () => undefined),
      this.api.client.model.list({ location, types: ["chat"] }).then((result) => result.data, () => []),
    ])
    const model = pickModel(title, fallback, models)
    const name = model && (models.find((candidate) => candidate.providerID === model.providerID && candidate.id === model.id)?.name ?? model.id)
    return { model, name }
  }

  private change(sessionID: string, id: string, change: Partial<Ask>) {
    this.update(sessionID, (questions) => ({ ...questions, items: questions.items.map((item) => item.id === id ? { ...item, ...change } : item) }))
  }

  private update(sessionID: string, update: (questions: Questions) => Questions) {
    this.set((draft) => { draft.sessions[sessionID] = update(draft.sessions[sessionID] ?? { items: [] }) })
  }
}
