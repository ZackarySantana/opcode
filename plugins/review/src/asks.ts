import { errorMessage } from "@opcode/core"
import { createRefresh, type SetTimer } from "@opcode/core/refresh"
import { sideSessionMetadata } from "@opcode/core/side"
import type { ModelRef, SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import { Identifier } from "@opencode/schema/identifier"
import { createSignal } from "solid-js"
import { answerOf, ASK_PERMISSIONS, askMetadata, askPrompt, mergeRead, streamText, type Answer, type Ask, type TextEvent } from "./ask"
import { PLUGIN_ID, type Anchor } from "./review"

/** A reviewed session's questions, and the session of its own that answers them. */
interface Questions {
  /** The answering session, once it exists. */
  readonly sessionID?: string
  /** Where it was made: questions about another worktree get a session there. */
  readonly directory?: string
  /** The answering model, and its name for the cards. */
  readonly ref?: ModelRef
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

/** How many of an answering session's latest messages are read: plenty for the questions still on screen. */
const READ_LIMIT = 200
/** Events after which an answering session's messages are read again. */
const CHANGES = [
  "session.inbox.delivered", "session.step.started", "session.step.ended", "session.step.failed", "session.tool.success", "session.tool.failed",
  "session.idle", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
] as const

/**
 * Asks the conversation's model about lines of the diff, without the agent seeing it. Each reviewed session gets one
 * answering session, made on the first question and archived so it stays out of the session lists, which keeps
 * follow-ups in context and its usage recorded like any session's. Questions last until dismissed or the terminal exits; they never reach the agent.
 */
export class Asks {
  private readonly state: { sessions: Record<string, Questions> }
  private readonly set: (mutation: (draft: { sessions: Record<string, Questions> }) => void) => void
  /** The answering session being made for a reviewed session, so quick questions share it. */
  private readonly opening = new Map<string, Promise<string>>()
  /**
   * Each answering session's messages, read here rather than from the host's store: the host only takes in a
   * session's messages once it shows that session, and these are never shown.
   */
  private readonly transcripts = createSignal<Record<string, SessionMessageInfo[]>>({})
  private readonly reads = new Map<string, ReturnType<typeof createRefresh<SessionMessageInfo[]>>>()
  private readonly stops: (() => void)[] = []

  constructor(private readonly api: Api, private readonly now: () => number, private readonly timer: SetTimer) {
    ;[this.state, this.set] = api.storage.memory<{ sessions: Record<string, Questions> }>("asks", { initial: { sessions: {} } })
    for (const type of CHANGES) this.stops.push(api.data.on(type, (event) => { if (this.answering(event.data.sessionID)) this.read(event.data.sessionID) }))
    const stream = (sessionID: string, event: TextEvent) => {
      if (this.answering(sessionID)) this.transcripts[1]((all) => ({ ...all, [sessionID]: streamText(all[sessionID] ?? [], event) }))
    }
    this.stops.push(
      api.data.on("session.text.started", (event) => stream(event.data.sessionID, { type: "started", messageID: event.data.assistantMessageID, at: event.created })),
      api.data.on("session.text.delta", (event) => stream(event.data.sessionID, { type: "delta", messageID: event.data.assistantMessageID, delta: event.data.delta })),
      api.data.on("session.text.ended", (event) => stream(event.data.sessionID, { type: "ended", messageID: event.data.assistantMessageID, text: event.data.text })),
    )
  }

  list = (sessionID: string): readonly Ask[] => this.state.sessions[sessionID]?.items ?? []
  model = (sessionID: string): string | undefined => this.state.sessions[sessionID]?.model

  /** A question's answer as it stands, streaming while the model writes it. */
  answer(ask: Ask): Answer {
    const answering = ask.session
    if (!answering) return answerOf([], ask)
    const messages = this.transcripts[0]()[answering]
    // Not read yet, such as after a reload of the plugin: read it now.
    if (!messages) this.read(answering)
    return answerOf(messages ?? [], ask)
  }

  dispose(): void {
    for (const stop of this.stops) stop()
    for (const read of this.reads.values()) read.dispose()
  }

  /** Whether a session answers questions here. */
  private answering(sessionID: string): boolean {
    return Object.values(this.state.sessions).some((questions) => questions.sessionID === sessionID || questions.items.some((item) => item.session === sessionID))
  }

  /** Reads an answering session's latest messages again, soon: a burst of events folds into one read. */
  private read(sessionID: string): void {
    let read = this.reads.get(sessionID)
    if (!read) {
      read = createRefresh(async (signal) => {
        const page = await this.api.client.message.list({ sessionID, order: "desc", limit: READ_LIMIT }, { signal })
        return [...page.data].reverse()
      }, (state) => { if (state.value) this.transcripts[1]((all) => ({ ...all, [sessionID]: mergeRead(all[sessionID] ?? [], state.value!) })) }, { timer: this.timer, delay: 50 })
      this.reads.set(sessionID, read)
    }
    read.schedule()
  }

  /** Asks about the anchored lines. The card shows at once; the answer streams into it. */
  async ask(sessionID: string, directory: string, anchor: Anchor, question: string, context: AskContext): Promise<void> {
    const id = `msg_${Identifier.create(false, this.now())}`
    // A plain copy: the anchor may be a live object of another store.
    const { file, side, start, end, quote, outside } = anchor
    const kept: Anchor = { file, side, start, end, quote: [...quote], ...outside ? { outside } : {} }
    this.update(sessionID, (questions) => ({ ...questions, items: [...questions.items, { id, anchor: kept, question }] }))
    try {
      const questions = this.state.sessions[sessionID]
      const existing = questions?.directory === directory ? questions.sessionID : undefined
      const answering = existing ?? await this.open(sessionID, directory)
      // The conversation's model may have changed since the last question: the next answer follows it.
      const chat = this.chatModel(sessionID)
      if (existing && chat && !sameModel(chat, questions?.ref)) {
        await this.api.client.session.switchModel({ sessionID: answering, model: chat })
        const model = await this.modelName(chat, { directory })
        this.update(sessionID, (current) => ({ ...current, ref: chat, model }))
      }
      this.change(sessionID, id, { session: answering })
      const text = askPrompt({ anchor: kept, question, ...context, first: !existing })
      await this.api.client.session.prompt({ sessionID: answering, id, text, metadata: askMetadata(id), delivery: "queue" })
      // Delivery may already have happened, before its event could be matched to this session.
      this.read(answering)
    } catch (error) {
      this.change(sessionID, id, { error: errorMessage(error) })
    }
  }

  /** Hides a question's card, and stops its answer when it's the one being worked on. */
  async dismiss(sessionID: string, id: string): Promise<void> {
    const questions = this.state.sessions[sessionID]
    const ask = questions?.items.find((item) => item.id === id)
    if (!questions || !ask) return
    const answer = this.answer(ask)
    this.update(sessionID, (current) => ({ ...current, items: current.items.filter((item) => item.id !== id) }))
    const answering = ask.session
    if (!answering) return
    try {
      if (answer.state === "waiting") await this.api.client.session.inbox.cancel({ sessionID: answering, inboxID: id })
      // A later question waiting behind it would be stopped too, so only the last one is interrupted.
      else if ((answer.state === "thinking" || answer.state === "answering") && questions.items.filter((item) => item.session === answering).at(-1)?.id === id) await this.api.client.session.interrupt({ sessionID: answering })
    } catch {
      // It may have finished in the meantime; the card is gone either way.
    }
  }

  private open(sessionID: string, directory: string): Promise<string> {
    const key = `${sessionID}:${directory}`
    let opening = this.opening.get(key)
    if (!opening) {
      opening = this.create(sessionID, directory).finally(() => this.opening.delete(key))
      this.opening.set(key, opening)
    }
    return opening
  }

  private async create(sessionID: string, directory: string): Promise<string> {
    const location = { directory }
    // The conversation's model, or OpenCode's default when the session doesn't name one.
    const model = this.chatModel(sessionID)
    const name = model ? await this.modelName(model, location)
      : await this.api.client.model.default({ location }).then((result) => result.data?.name, () => undefined)
    const parent = this.api.data.session.get(sessionID)?.title
    const session = await this.api.client.session.create({
      title: parent ? `Review questions: ${parent}` : "Review questions",
      location, permissions: [...ASK_PERMISSIONS], metadata: sideSessionMetadata({ parentID: sessionID, plugin: PLUGIN_ID }),
      ...model ? { model } : {},
    })
    // Archived sessions stay out of the session lists and pickers.
    await this.api.client.session.update({ sessionID: session.id, archived: true })
    this.update(sessionID, (questions) => ({ ...questions, sessionID: session.id, directory, ref: model, model: name }))
    return session.id
  }

  /** The model the reviewed conversation uses now, as a plain copy of the host's. */
  private chatModel(sessionID: string): ModelRef | undefined {
    const model = this.api.data.session.get(sessionID)?.model
    return model && { id: model.id, providerID: model.providerID, ...model.variant ? { variant: model.variant } : {} }
  }

  private async modelName(model: ModelRef, location: { directory: string }): Promise<string> {
    const models = await this.api.client.model.list({ location, types: ["chat"] }).then((result) => result.data, () => [])
    return models.find((candidate) => candidate.providerID === model.providerID && candidate.id === model.id)?.name ?? model.id
  }

  private change(sessionID: string, id: string, change: Partial<Ask>) {
    this.update(sessionID, (questions) => ({ ...questions, items: questions.items.map((item) => item.id === id ? { ...item, ...change } : item) }))
  }

  private update(sessionID: string, update: (questions: Questions) => Questions) {
    this.set((draft) => { draft.sessions[sessionID] = update(draft.sessions[sessionID] ?? { items: [] }) })
  }
}

const sameModel = (a: ModelRef, b: ModelRef | undefined) => !!b && a.id === b.id && a.providerID === b.providerID && a.variant === b.variant
