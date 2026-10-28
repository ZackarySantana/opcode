import { errorMessage } from "@opcode/core"
import { createRefresh, setTimer, type RefreshState, type SetTimer } from "@opcode/core/refresh"
import { createSchedule, type Schedule } from "@opcode/tabs/schedule"
import { createSignal, type Signal } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { formatFeedback } from "./comments"
import { fetchFeedback, fetchSnapshot, runGh, type Runner } from "./gh"
import { view, type Settings, type Snapshot } from "./model"
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
  /** The snapshot's lists, without the pull requests inactive longer than the ignore setting. */
  view = () => view(this.snapshot(), this.settings().ignoreDays, this.now())

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

/** Sends the review feedback on the open session's pull request to that session, as your prompt. */
export async function sendFeedback(api: Pick<Context, "client" | "ui">, signal: AbortSignal, prompt?: string, run: Runner = runGh): Promise<void> {
  const route = api.ui.router.current()
  if (route.type !== "session") return api.ui.toast.show({ variant: "warning", message: "Open a session first: /ghpr-comments sends to the open session." })
  const { sessionID } = route
  api.ui.toast.show({ message: "Fetching review comments..." })
  try {
    // The session's directory, not the client's, picks the branch.
    const session = await api.client.session.get({ sessionID }, { signal })
    const feedback = await fetchFeedback(run, signal, session.location.directory)
    const { text, summary } = formatFeedback(feedback, prompt)
    const { pr } = feedback
    const title = `PR #${pr.number}`
    if (!text) return api.ui.toast.show({ title, message: `No review comments to send. ${summary}` })
    await api.client.session.prompt({ sessionID, text }, { signal })
    api.ui.toast.show({ variant: "success", title, message: `Sent review comments. ${summary}` })
  } catch (error) {
    if (!signal.aborted) api.ui.toast.show({ variant: "error", title: "Review comments", message: errorMessage(error) })
  }
}
