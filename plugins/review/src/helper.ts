import { createRefresh, type SetTimer } from "@opcode/core/refresh"
import { sideSessionMetadata } from "@opcode/core/side"
import type { ModelRef, SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import { Identifier } from "@opencode/schema/identifier"
import { createSignal } from "solid-js"
import { ASK_PERMISSIONS, mergeRead, streamText, type TextEvent } from "./ask"
import { PLUGIN_ID } from "./review"

/** A reviewed session's helper: the session of its own that answers questions and writes guided reviews. */
interface Helper {
  readonly sessionID: string
  /** Where it was made: work on another worktree gets a helper there. */
  readonly directory: string
  /** The model it answers with, and its name for the cards. */
  readonly ref?: ModelRef
  readonly model?: string
  /** The kinds of prompt it has had, each of which explains itself the first time. */
  readonly introduced: readonly string[]
}

type Api = Pick<Context, "client" | "data" | "storage">

/** How many of a helper's latest messages are read: plenty for the work still on screen. */
const READ_LIMIT = 200
/** Events after which a helper's messages are read again. */
const CHANGES = [
  "session.inbox.delivered", "session.step.started", "session.step.ended", "session.step.failed", "session.tool.success", "session.tool.failed",
  "session.idle", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
] as const

/**
 * The sessions that do work beside a reviewed one, out of the agent's sight: one per reviewed session and directory,
 * made when first needed, on the conversation's model and following it when it changes, able only to read and search
 * the repository, and archived so it stays out of the session lists. Its usage is recorded like any session's.
 */
export class Helpers {
  private readonly state: { sessions: Record<string, Helper> }
  private readonly set: (mutation: (draft: { sessions: Record<string, Helper> }) => void) => void
  /** The helper being made for a reviewed session and directory, so quick prompts share it. */
  private readonly opening = new Map<string, Promise<Helper>>()
  /**
   * Each helper's messages, read here rather than from the host's store: the host only takes in a session's
   * messages once it shows that session, and helpers are never shown.
   */
  private readonly transcripts = createSignal<Record<string, SessionMessageInfo[]>>({})
  private readonly reads = new Map<string, ReturnType<typeof createRefresh<SessionMessageInfo[]>>>()
  /** Every helper made here, including ones since replaced, whose earlier answers are still shown. */
  private readonly known = new Set<string>()
  /** The latest prompt sent to each helper. */
  private readonly latest = new Map<string, string>()
  private readonly stops: (() => void)[] = []

  constructor(private readonly api: Api, private readonly now: () => number, private readonly timer: SetTimer) {
    ;[this.state, this.set] = api.storage.memory<{ sessions: Record<string, Helper> }>("helpers", { initial: { sessions: {} } })
    for (const helper of Object.values(this.state.sessions)) this.known.add(helper.sessionID)
    for (const type of CHANGES) this.stops.push(api.data.on(type, (event) => { if (this.known.has(event.data.sessionID)) this.read(event.data.sessionID) }))
    const stream = (sessionID: string, event: TextEvent) => {
      if (this.known.has(sessionID)) this.transcripts[1]((all) => ({ ...all, [sessionID]: streamText(all[sessionID] ?? [], event) }))
    }
    this.stops.push(
      api.data.on("session.text.started", (event) => stream(event.data.sessionID, { type: "started", messageID: event.data.assistantMessageID, at: event.created })),
      api.data.on("session.text.delta", (event) => stream(event.data.sessionID, { type: "delta", messageID: event.data.assistantMessageID, delta: event.data.delta })),
      api.data.on("session.text.ended", (event) => stream(event.data.sessionID, { type: "ended", messageID: event.data.assistantMessageID, text: event.data.text })),
    )
  }

  /** The name of the model the reviewed session's helper answers with. */
  model = (sessionID: string): string | undefined => this.state.sessions[sessionID]?.model

  /** A helper's messages as they stand, streaming while the model writes. */
  transcript(helper: string): readonly SessionMessageInfo[] {
    const messages = this.transcripts[0]()[helper]
    // Not read yet, such as after a reload of the plugin: read it now.
    if (!messages) this.read(helper)
    return messages ?? []
  }

  /** A new ID for a prompt, which also finds its answer. */
  id = () => `msg_${Identifier.create(false, this.now())}`

  /**
   * Sends a prompt to the reviewed session's helper in this directory, made on first use and switched to the
   * conversation's model when that changed. `intro` builds the prompt, told whether this kind of prompt is new to
   * the helper. Returns the helper that got it.
   */
  async send(sessionID: string, directory: string, input: { id: string; kind: string; metadata: Record<string, unknown>; text: (intro: boolean) => string }): Promise<string> {
    let helper = this.state.sessions[sessionID]
    if (helper?.directory !== directory) helper = await this.open(sessionID, directory)
    const chat = this.chatModel(sessionID)
    if (chat && !sameModel(chat, helper.ref)) {
      await this.api.client.session.switchModel({ sessionID: helper.sessionID, model: chat })
      helper = { ...helper, ref: chat, model: await this.modelName(chat, { directory }) }
    }
    const intro = !helper.introduced.includes(input.kind)
    const sent = { ...helper, introduced: intro ? [...helper.introduced, input.kind] : helper.introduced }
    this.set((draft) => { draft.sessions[sessionID] = sent })
    this.latest.set(sent.sessionID, input.id)
    await this.api.client.session.prompt({ sessionID: sent.sessionID, id: input.id, text: input.text(intro), metadata: input.metadata as never, delivery: "queue" })
    // Delivery may already have happened, before its event could be read.
    this.read(sent.sessionID)
    return sent.sessionID
  }

  /** Takes a prompt back while it waits, or stops the helper when it's working on the latest one. */
  async cancel(helper: string, id: string, state: "waiting" | "working"): Promise<void> {
    try {
      if (state === "waiting") await this.api.client.session.inbox.cancel({ sessionID: helper, inboxID: id })
      // A later prompt waiting behind it would be stopped too, so only the latest one is interrupted.
      else if (this.latest.get(helper) === id) await this.api.client.session.interrupt({ sessionID: helper })
    } catch {
      // It may have finished in the meantime.
    }
  }

  dispose(): void {
    for (const stop of this.stops) stop()
    for (const read of this.reads.values()) read.dispose()
  }

  /** Reads a helper's latest messages again, soon: a burst of events folds into one read. */
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

  private open(sessionID: string, directory: string): Promise<Helper> {
    const key = `${sessionID}:${directory}`
    let opening = this.opening.get(key)
    if (!opening) {
      opening = this.create(sessionID, directory).finally(() => this.opening.delete(key))
      this.opening.set(key, opening)
    }
    return opening
  }

  private async create(sessionID: string, directory: string): Promise<Helper> {
    const location = { directory }
    // The conversation's model, or OpenCode's default when the session doesn't name one.
    const model = this.chatModel(sessionID)
    const name = model ? await this.modelName(model, location)
      : await this.api.client.model.default({ location }).then((result) => result.data?.name, () => undefined)
    const parent = this.api.data.session.get(sessionID)?.title
    const session = await this.api.client.session.create({
      title: parent ? `Review helper: ${parent}` : "Review helper",
      location, permissions: [...ASK_PERMISSIONS], metadata: sideSessionMetadata({ parentID: sessionID, plugin: PLUGIN_ID }),
      ...model ? { model } : {},
    })
    // Archived sessions stay out of the session lists and pickers.
    await this.api.client.session.update({ sessionID: session.id, archived: true })
    const helper: Helper = { sessionID: session.id, directory, ref: model, model: name, introduced: [] }
    this.known.add(session.id)
    this.set((draft) => { draft.sessions[sessionID] = helper })
    return helper
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
}

const sameModel = (a: ModelRef, b: ModelRef | undefined) => !!b && a.id === b.id && a.providerID === b.providerID && a.variant === b.variant
