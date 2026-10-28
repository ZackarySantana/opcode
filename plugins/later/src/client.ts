import { createSerialQueue } from "@opcode/core"
import { followState } from "@opcode/core/follow"
import type { SetTimer } from "@opcode/core/refresh"
import { describeRpcError, toJson } from "@opcode/core/rpc"
import type { OpenCodeClient } from "@opencode/client"
import { createSignal } from "solid-js"
import { defaultSettings, findItem, type LaterItem, type LaterState, type Settings } from "./domain"
import { LaterRpc } from "./rpc"
import type { Written } from "./service"

/** The server's Later list, as a terminal reaches it. */
export interface Remote {
  state(signal?: AbortSignal): Promise<LaterState>
  add(message: string): Promise<Written & { id: string }>
  edit(item: LaterItem, message: string): Promise<Written>
  complete(item: LaterItem): Promise<Written>
  restore(item: LaterItem): Promise<Written>
  delete(item: LaterItem): Promise<Written>
  move(id: string, offset: -1 | 1): Promise<Written>
  settings(change: Partial<Settings>): Promise<LaterState>
  /** Each published state, live only: states published while disconnected are missed. */
  changes(signal: AbortSignal): AsyncIterable<LaterState>
}

/**
 * The list is the same in every location, so calls go to the caller's current one, or the server's default without
 * one. The client changes when the server restarts.
 */
export function createRemote(client: () => Pick<OpenCodeClient, "rpc">, location: () => { directory: string } | undefined): Remote {
  const rpc = () => client().rpc(LaterRpc)
  const call = (signal?: AbortSignal) => ({ location: location(), signal })
  // Items go back as they came, without fields JSON can't carry.
  const item = (item: LaterItem) => toJson(item) as never
  return {
    state: async (signal) => await rpc().state({}, call(signal)) as LaterState,
    add: async (message) => await rpc().add({ message }, call()) as Written & { id: string },
    edit: async (entry, message) => await rpc().edit({ item: item(entry), message }, call()) as Written,
    complete: async (entry) => await rpc().complete({ item: item(entry) }, call()) as Written,
    restore: async (entry) => await rpc().restore({ item: item(entry) }, call()) as Written,
    delete: async (entry) => await rpc().delete({ item: item(entry) }, call()) as Written,
    move: async (id, offset) => await rpc().move({ id, offset }, call()) as Written,
    settings: async (change) => await rpc().settings({ settings: change }, call()) as LaterState,
    changes: (signal) => ({
      async *[Symbol.asyncIterator]() {
        for await (const event of rpc().events.subscribe("changed", { signal })) yield event.data as unknown as LaterState
      },
    }),
  }
}

/** Why a call failed, saying what to do when the server doesn't run the plugin's server side. */
export const describeError = (error: unknown) => describeRpcError(error, { name: "Later", package: "@lidtop/opencode-later" })

const empty = { active: [], completed: [] } as const

/**
 * The server's list and settings, kept live. Changes are sent one at a time, in order, and each answer applies at once.
 * A failed change rejects with why, after reading the list again in case it applied. Renders nothing.
 */
export class LaterClient {
  private readonly current = createSignal<LaterState>()
  /** Settings changes sent but not yet answered, shown over the server's so quick changes build on each other. */
  private readonly pending = createSignal<readonly Partial<Settings>[]>([])
  private readonly sends = createSerialQueue()
  private readonly follower: ReturnType<typeof followState<LaterState>>

  /** `problem` reports why the list can't be read, until it can. */
  constructor(private readonly remote: Remote, problem: (message: string | undefined) => void, timer?: SetTimer) {
    this.follower = followState<LaterState>({
      read: (signal) => remote.state(signal),
      changes: (signal) => remote.changes(signal),
      apply: (state) => this.current[1](state),
      problem,
      describe: describeError,
      timer,
      retryMilliseconds: 10_000,
    })
  }

  /** Empty until the list is first read. */
  list = (): Pick<LaterState, "active" | "completed"> => this.current[0]() ?? empty
  settings = (): Settings => this.pending[0]().reduce<Settings>((settings, change) => ({ ...settings, ...change }), this.current[0]()?.settings ?? defaultSettings)
  item = (id: string) => findItem(this.list(), id)

  start(): void {
    this.follower.start()
  }

  /** Reads the whole list again. */
  resync(): void {
    void this.follower.resync()
  }

  async add(message: string): Promise<string> {
    return (await this.send(() => this.remote.add(message))).id
  }

  /** Each is false when the item changed elsewhere first, and nothing changed. */
  edit = (item: LaterItem, message: string) => this.written(() => this.remote.edit(item, message))
  complete = (item: LaterItem) => this.written(() => this.remote.complete(item))
  restore = (item: LaterItem) => this.written(() => this.remote.restore(item))
  delete = (item: LaterItem) => this.written(() => this.remote.delete(item))
  /** False past either end. */
  move = (id: string, offset: -1 | 1) => this.written(() => this.remote.move(id, offset))

  /** Applies at once here, and everywhere once the server has saved it. */
  async updateSettings(change: Partial<Settings>): Promise<void> {
    this.pending[1]((pending) => [...pending, change])
    try { await this.send(async () => ({ state: await this.remote.settings(change) })) }
    finally { this.pending[1]((pending) => pending.filter((sent) => sent !== change)) }
  }

  dispose(): void {
    this.follower.dispose()
  }

  private async written(send: () => Promise<Written>): Promise<boolean> {
    return (await this.send(send)).changed
  }

  private send<T extends { state: LaterState }>(send: () => Promise<T>): Promise<T> {
    return this.sends(async () => {
      try {
        const answer = await send()
        this.follower.offer(answer.state)
        return answer
      } catch (error) {
        // The change may have applied before the answer was lost.
        this.resync()
        throw new Error(describeError(error))
      }
    })
  }
}
