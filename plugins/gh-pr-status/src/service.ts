import { createSerialQueue, errorMessage } from "@opcode/core"
import { failover, joinShared, packageVersion } from "@opcode/core/process"
import { createRefresh, setTimer, type RefreshState, type SetTimer } from "@opcode/core/refresh"
import { createSchedule, type Schedule } from "@opcode/core/schedule"
import { fetchSnapshot, type Runner } from "./gh"
import { defaultSettings, PLUGIN_ID, readSettings, type PullRequestsState, type Settings, type SettingsChange, type Snapshot } from "./model"

/** How long to wait before reading the saved settings again after a read failed. */
const LOAD_RETRY = 10_000

/** What the service needs from its host: the saved settings, and a way to reach every client. */
export interface Ports {
  /** The saved settings as stored, of any shape. */
  loadSettings(): Promise<unknown>
  saveSettings(settings: Settings): Promise<void>
  publish(state: PullRequestsState): Promise<void>
}

/** The pull requests every client shows: the settings, and the latest snapshot from gh on the settings' schedule. */
export class PullRequestsService {
  private settings: Settings = defaultSettings
  /** Whether `settings` are the saved ones. Until then they are the defaults, and saving them would lose the saved ones. */
  private loaded = false
  private read: RefreshState<Snapshot> = { loading: false }
  private revision = 0
  private disposed = false
  private cancelLoad?: () => void
  private readonly server = crypto.randomUUID()
  private readonly started = Date.now()
  private readonly reads: ReturnType<typeof createRefresh<Snapshot>>
  private readonly schedule: Schedule
  private readonly writes = createSerialQueue()
  /** Settles once the saved settings were read, or failed to be, and the first refresh has started. */
  readonly ready: Promise<void>

  constructor(private readonly ports: Ports, run: Runner, private readonly timer: SetTimer = setTimer) {
    // A refresh supersedes one in flight, and a failure keeps the last snapshot beside the error.
    this.reads = createRefresh((signal) => fetchSnapshot(run, signal), (state) => { this.read = state; this.changed() }, { timer })
    this.schedule = createSchedule(() => this.refresh(), () => this.settings.refreshMinutes, { timer })
    this.ready = this.loadSettings().then(() => { if (!this.disposed) this.schedule.start() })
  }

  state(): PullRequestsState {
    const { value, loading, error } = this.read
    const next = this.schedule.next()
    return {
      server: this.server, started: this.started, revision: this.revision, settings: this.settings, refreshing: loading,
      ...value ? { snapshot: value } : {}, ...error ? { error } : {}, ...next === undefined ? {} : { nextRefreshIn: next - Date.now() },
    }
  }

  /** Every refresh, automatic or not, restarts the countdown. */
  refresh(): void {
    this.schedule.restart()
    void this.reads.refresh()
  }

  /**
   * Saves the change, then shares it; changes apply in the order they arrive, and one that can't be saved doesn't
   * apply. While the saved settings can't be read, changes are refused: saving would replace them with defaults.
   */
  update(change: SettingsChange): Promise<PullRequestsState> {
    if (this.disposed) return Promise.reject(new Error("Pull requests stopped on the server"))
    return this.writes(async () => {
      if (!this.loaded && !await this.loadSettings()) throw new Error("The saved settings can't be read right now, so they can't be changed. Try again shortly.")
      const next = readSettings({ ...this.settings, ...change })
      await this.ports.saveSettings(next)
      this.settings = next
      this.schedule.reschedule()
      this.changed()
      return this.state()
    })
  }

  dispose(): void {
    this.disposed = true
    this.cancelLoad?.()
    this.reads.dispose()
    this.schedule.dispose()
  }

  /**
   * Reads the saved settings, and on failure keeps the defaults for reads and tries again on a timer. Settings read late
   * are announced. Whether they are the saved ones now.
   */
  private async loadSettings(): Promise<boolean> {
    if (this.loaded) return true
    try {
      const stored = await this.ports.loadSettings()
      if (this.disposed || this.loaded) return this.loaded
      this.settings = readSettings(stored)
      this.loaded = true
      this.cancelLoad?.()
      if (this.schedule.next() !== undefined) {
        this.schedule.reschedule()
        this.changed()
      }
      return true
    } catch (error) {
      if (this.disposed) return false
      console.warn(`${PLUGIN_ID}: can't read the saved settings, using the defaults until they can be: ${errorMessage(error)}`)
      this.cancelLoad?.()
      this.cancelLoad = this.timer(() => void this.loadSettings(), LOAD_RETRY)
      return false
    }
  }

  /** Clients get the full state on each change; a refresh changes it twice, as it starts and ends, which is fine at this size. */
  private changed() {
    if (this.disposed) return
    this.revision++
    const state = this.state()
    void this.ports.publish(state).catch((error) => console.warn(`${PLUGIN_ID}: could not announce a change: ${errorMessage(error)}`))
  }
}

/**
 * The server process's service, which every location instance joins with its own ports. `start` runs only for the
 * first to join, and its runner and timer serve them all. The service uses the oldest member's ports, and the next
 * one's if those fail: plugin storage is the same in every location, and clients receive every location's events, so
 * one announcement per change saves the traffic of one per location (clients tolerate duplicates anyway).
 */
export function joinService(member: Ports, start: (ports: Ports) => PullRequestsService) {
  // A different version's service may hold the plugin's place until its locations unload; clients prefer the newer one.
  const { value, leave } = joinShared(`${PLUGIN_ID}.service@${packageVersion(new URL("../package.json", import.meta.url))}`, member, {
    start: (members) => start({
      loadSettings: () => failover(members, (ports) => ports.loadSettings()),
      saveSettings: (settings) => failover(members, (ports) => ports.saveSettings(settings)),
      publish: (state) => failover(members, (ports) => ports.publish(state)),
    }),
    stop: (service) => service.dispose(),
  })
  return { service: value, leave }
}
