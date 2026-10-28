import { createSerialQueue, errorMessage } from "@opcode/core"
import { createRefresh, setTimer, type RefreshState, type SetTimer } from "@opcode/core/refresh"
import { createSchedule, type Schedule } from "@opcode/core/schedule"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { fetchSnapshot, runGh, type Runner } from "./gh"
import { defaultSettings, readSettings, type PullRequestsState, type Settings, type SettingsChange, type Snapshot } from "./model"
import { PLUGIN_ID } from "./rpc"

const SETTINGS = "settings"

/** What a location instance of the server plugin lends the shared service: its storage, and a way to reach clients. */
export interface Member {
  readonly storage: Pick<StorageDomain, "get" | "set">
  publish(state: PullRequestsState): Promise<void>
}

/**
 * The pull requests every client shows: the settings, saved in plugin storage, and the latest snapshot from gh, on the
 * settings' schedule. One per server process, whichever location instances use it.
 */
export class PullRequestsService {
  private settings: Settings = defaultSettings
  private read: RefreshState<Snapshot> = { loading: false }
  private revision = 0
  private readonly server = crypto.randomUUID()
  private readonly reads: ReturnType<typeof createRefresh<Snapshot>>
  private readonly schedule: Schedule
  private readonly writes = createSerialQueue()
  /** Settles once the saved settings are read and the first refresh has started. */
  readonly ready: Promise<void>

  /** Storage and publishing go through the first of `members` that works: plugin storage is the same in every location. */
  constructor(private readonly members: readonly Member[], run: Runner, timer: SetTimer) {
    // RPC validation rejects undefined values, so the snapshot is kept as the JSON it travels as.
    const load = async (signal: AbortSignal) => JSON.parse(JSON.stringify(await fetchSnapshot(run, signal))) as Snapshot
    // A refresh supersedes one in flight, and a failure keeps the last snapshot beside the error.
    this.reads = createRefresh(load, (state) => { this.read = state; this.changed() }, { timer })
    this.schedule = createSchedule(() => this.refresh(), () => this.settings.refreshMinutes, { timer })
    this.ready = this.loadSettings().then(() => this.schedule.start())
  }

  state(): PullRequestsState {
    const { value, loading, error } = this.read
    const next = this.schedule.next()
    return {
      server: this.server, revision: this.revision, settings: this.settings, refreshing: loading,
      ...value ? { snapshot: value } : {}, ...error ? { error } : {}, ...next === undefined ? {} : { nextRefresh: next },
    }
  }

  /** Every refresh, automatic or not, restarts the countdown. */
  refresh(): void {
    this.schedule.restart()
    void this.reads.refresh()
  }

  /** Saves the change, then shares it; changes apply in the order they arrive. */
  update(change: SettingsChange): Promise<PullRequestsState> {
    return this.writes(async () => {
      const next = readSettings({ ...this.settings, ...change })
      await this.first((member) => member.storage.set(SETTINGS, { ...next }))
      this.settings = next
      this.schedule.reschedule()
      this.changed()
      return this.state()
    })
  }

  dispose(): void {
    this.reads.dispose()
    this.schedule.dispose()
  }

  private async loadSettings() {
    try { this.settings = readSettings(await this.first((member) => member.storage.get(SETTINGS))) }
    catch (error) { console.warn(`${PLUGIN_ID}: using default settings: ${errorMessage(error)}`) }
  }

  private changed() {
    this.revision++
    const state = this.state()
    // Clients receive every location's events, so one member announces each change. Clients that miss it re-read.
    void this.first((member) => member.publish(state)).catch((error) => console.warn(`${PLUGIN_ID}: could not announce a change: ${errorMessage(error)}`))
  }

  /** A member leaving may already have lost its host. */
  private async first<T>(use: (member: Member) => Promise<T>): Promise<T> {
    let failure: unknown = new Error("No plugin instance is loaded")
    for (const member of [...this.members]) {
      try { return await use(member) } catch (error) { failure = error }
    }
    throw failure
  }
}

// Each location instance loads its own copy of this module, so the service is shared through the process's globals.
const SHARED = Symbol.for(`${PLUGIN_ID}.service`)
type Shared = { service: PullRequestsService; members: Member[] }
const registry = globalThis as typeof globalThis & { [SHARED]?: Shared }

/**
 * The server process's service, started by the first member to join, with its runner and timer, and stopped when the
 * last one leaves.
 */
export function joinService(member: Member, run: Runner = runGh, timer: SetTimer = setTimer) {
  let shared = registry[SHARED]
  if (shared) shared.members.push(member)
  else {
    const members = [member]
    shared = registry[SHARED] = { members, service: new PullRequestsService(members, run, timer) }
  }
  const joined = shared
  let left = false
  return {
    service: joined.service,
    leave() {
      if (left) return
      left = true
      joined.members.splice(joined.members.indexOf(member), 1)
      if (joined.members.length) return
      joined.service.dispose()
      if (registry[SHARED] === joined) delete registry[SHARED]
    },
  }
}
