import { createSerialQueue } from "@opcode/core"
import type { Plugin } from "@opencode/plugin"
import type { Reply, ReplyStatus } from "./review"

/** What a session's agent was sent and has answered, kept by the server so it outlives terminals. */
export interface SessionRecord {
  readonly comments: readonly string[]
  readonly replies: Readonly<Record<string, Reply>>
}

type Storage = Pick<Plugin.Context["storage"], "get" | "set">

export class ReviewRecords {
  // Each change reads and rewrites one session's entry; serializing them keeps concurrent changes from losing each other.
  private readonly serial = createSerialQueue()
  constructor(private readonly storage: Storage) {}

  async get(sessionID: string): Promise<SessionRecord | undefined> {
    return await this.storage.get(key(sessionID)) as SessionRecord | undefined
  }

  /** The comment IDs a prompt carried, so the agent can reply to them. */
  sent(sessionID: string, ids: readonly string[]): Promise<void> {
    return this.change(sessionID, (record) => ({ ...record, comments: [...new Set([...record.comments, ...ids])] }))
  }

  /** Replies to known comments; returns the IDs it didn't know. A newer reply replaces an older one. */
  reply(sessionID: string, replies: readonly { id: string; status: ReplyStatus; reply: string }[], now: number): Promise<string[]> {
    let unknown: string[] = []
    return this.change(sessionID, (record) => {
      const known = new Set(record.comments)
      unknown = replies.filter((reply) => !known.has(reply.id)).map((reply) => reply.id)
      const added = Object.fromEntries(replies.filter((reply) => known.has(reply.id)).map(({ id, status, reply }) => [id, { status, reply: reply.trim(), at: now }]))
      return { ...record, replies: { ...record.replies, ...added } }
    }).then(() => unknown)
  }

  private change(sessionID: string, update: (record: SessionRecord) => SessionRecord): Promise<void> {
    return this.serial(async () => {
      const record = await this.get(sessionID) ?? { comments: [], replies: {} }
      await this.storage.set(key(sessionID), update(record) as never)
    })
  }
}

const key = (sessionID: string) => `session/${sessionID}`
