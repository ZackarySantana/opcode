import { createSerialQueue, errorMessage } from "@opcode/core"
import { failover, joinShared, packageVersion } from "@opcode/core/process"
import { setTimer, type SetTimer } from "@opcode/core/refresh"
import {
  addItem, changeSettings, completeItem, deleteItem, editItem, findItem, moveItem, PLUGIN_ID, readList, restoreItem, view,
  type LaterItem, type LaterList, type LaterState, type Settings,
} from "./domain"

/** How long changes gather before one announcement carries them all. */
const PUBLISH_DELAY = 100

/** What the service needs from its host: the stored list, and a way to reach every client. */
export interface Ports {
  /** The stored list as stored, of any shape, or undefined when nothing is stored. */
  load(): Promise<unknown>
  save(list: LaterList): Promise<void>
  publish(state: LaterState): Promise<void>
}

/** Runs one read-modify-write of the stored list at a time. */
export type Writes = <T>(operation: () => Promise<T>) => Promise<T>

/** The answer to a change: whether it applied, and the list after it, or as it is when it didn't. */
export interface Written {
  readonly changed: boolean
  readonly state: LaterState
}

/**
 * The Later list every client and the agent's tools change. It keeps no copy: each read loads the stored list, and each
 * change loads, changes, and saves it in `writes`, which every service in the process shares, of any version, so a
 * change never overwrites one it didn't see. A list that can't be loaded fails the read or change; nothing reads it as
 * empty, so nothing can save an empty list over it.
 */
export class LaterService {
  private disposed = false
  /** The newest state to announce, and how to cancel announcing it. */
  private announcing?: { state: LaterState; cancel: () => void }

  constructor(private readonly ports: Ports, private readonly writes: Writes, private readonly timer: SetTimer = setTimer) {}

  async state(): Promise<LaterState> {
    return view(await this.load())
  }

  async item(id: string): Promise<LaterItem | undefined> {
    return findItem(await this.load(), id)
  }

  /** When the user turned the agent's tools off, or undefined while they are on. */
  async toolsDisabledAt(): Promise<number | undefined> {
    return (await this.load()).toolsDisabledAt
  }

  async add(text: string): Promise<Written & { id: string }> {
    const id = crypto.randomUUID()
    return { id, ...await this.write((list, now) => addItem(list, id, text, now)) }
  }

  edit(item: LaterItem, text: string): Promise<Written> {
    return this.write((list, now) => editItem(list, item, text, now))
  }

  complete(item: LaterItem): Promise<Written> {
    return this.write((list, now) => completeItem(list, item, now))
  }

  restore(item: LaterItem): Promise<Written> {
    return this.write((list, now) => restoreItem(list, item, now))
  }

  delete(item: LaterItem): Promise<Written> {
    return this.write((list) => deleteItem(list, item))
  }

  move(id: string, offset: -1 | 1): Promise<Written> {
    return this.write((list) => moveItem(list, id, offset))
  }

  async updateSettings(change: Partial<Settings>): Promise<LaterState> {
    return (await this.write((list, now) => changeSettings(list, change, now))).state
  }

  dispose(): void {
    this.disposed = true
    this.announcing?.cancel()
    this.announcing = undefined
  }

  /** Settles once every change queued so far is done. */
  drained(): Promise<void> {
    return this.writes(async () => {})
  }

  private async load(): Promise<LaterList> {
    let stored: unknown
    try { stored = await this.ports.load() } catch (error) {
      throw new Error(`The Later list can't be read right now: ${errorMessage(error)}. Try again shortly.`)
    }
    return readList(stored)
  }

  /** Saves a change made to the list as stored now, then announces it. A change that doesn't apply saves nothing. */
  private write(change: (list: LaterList, now: number) => LaterList | undefined): Promise<Written> {
    if (this.disposed) return Promise.reject(new Error("Later stopped on the server"))
    return this.writes(async () => {
      const list = await this.load()
      const next = change(list, Date.now())
      if (!next) return { changed: false, state: view(list) }
      const saved = { ...next, revision: list.revision + 1 }
      await this.ports.save(saved)
      const state = view(saved)
      this.announce(state)
      return { changed: true, state }
    })
  }

  /** Clients get the full state, once for changes made close together: each state holds every change before it. */
  private announce(state: LaterState) {
    if (this.disposed) return
    if (this.announcing) {
      this.announcing.state = state
      return
    }
    const announcing = this.announcing = {
      state,
      cancel: this.timer(() => {
        this.announcing = undefined
        void this.ports.publish(announcing.state).catch((error) => console.warn(`${PLUGIN_ID}: could not announce a change: ${errorMessage(error)}`))
      }, PUBLISH_DELAY),
    }
  }
}

/**
 * The server process's service, which every location instance joins with its own ports. It uses the oldest member's
 * ports, and the next one's if those fail: plugin storage is the same in every location, and clients receive every
 * location's events, so one announcement per change saves the traffic of one per location.
 */
export function joinService(member: Ports, timer?: SetTimer) {
  const { value, leave } = joinShared(`${PLUGIN_ID}.service@${packageVersion(new URL("../package.json", import.meta.url))}`, member, {
    start: (members) => {
      const writes = joinWrites()
      const service = new LaterService({
        load: () => failover(members, (ports) => ports.load()),
        save: (list) => failover(members, (ports) => ports.save(list)),
        publish: (state) => failover(members, (ports) => ports.publish(state)),
      }, writes.value, timer)
      return { service, leave: writes.leave }
    },
    stop: ({ service, leave }) => {
      service.dispose()
      // Once the changes already queued are done: a service starting meanwhile joins this queue rather than a new one
      // that would let its changes interleave with them.
      void service.drained().then(leave)
    },
  })
  return { service: value.service, leave }
}

/**
 * The process's queue for changes to the stored list. Not keyed by version: while an upgrade runs two versions'
 * services, both change the list one at a time. Other versions call this value, so it stays a plain serial queue.
 */
export function joinWrites() {
  return joinShared<object, Writes>(`${PLUGIN_ID}.writes`, {}, { start: createSerialQueue, stop: () => {} })
}
