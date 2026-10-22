import { createRefresh, setTimer, type RefreshState, type SetTimer } from "@opcode/core/refresh"
import { createSchedule, type Schedule } from "@opcode/tabs/schedule"
import { createSignal, type Signal } from "solid-js"
import { fetchSnapshot, runGh, type Runner } from "./gh"
import type { Settings, Snapshot } from "./model"
import type { SettingsDatabase } from "./sqlite"

/** Owns the latest snapshot from gh, the settings, and the refresh schedule. Renders nothing. */
export class PullRequestsController {
  private readonly state = createSignal<RefreshState<Snapshot>>({ loading: false })
  private readonly settingsSignal: Signal<Settings>
  private readonly reads: ReturnType<typeof createRefresh<Snapshot>>
  private readonly schedule: Schedule

  constructor(private readonly database: SettingsDatabase, run: Runner = runGh, timer: SetTimer = setTimer) {
    this.settingsSignal = createSignal(database.settings())
    // A refresh supersedes one in flight, and a failure keeps the last snapshot beside the error.
    this.reads = createRefresh((signal) => fetchSnapshot(run, signal), (state) => this.state[1](state), { timer })
    this.schedule = createSchedule(() => this.refresh(), () => this.settings().refreshMinutes, timer)
  }

  snapshot = () => this.state[0]().value
  error = () => this.state[0]().error
  refreshing = () => this.state[0]().loading
  settings = () => this.settingsSignal[0]()
  /** Ages are relative to this, so views re-render as time passes. */
  now = () => this.schedule.now()
  nextRefresh = () => this.schedule.next()
  start = () => this.schedule.start()

  /** Every refresh, automatic or not, restarts the countdown. */
  refresh(): void {
    this.schedule.restart()
    void this.reads.refresh()
  }

  updateSettings(change: Partial<Settings>): void {
    const next = { ...this.settings(), ...change }
    this.database.save(next)
    this.settingsSignal[1](next)
    this.schedule.reschedule()
  }

  dispose(): void {
    this.reads.dispose()
    this.schedule.dispose()
  }
}
