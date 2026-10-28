import { createSerialQueue, errorMessage } from "@opcode/core"
import { consumeLive } from "@opcode/core/live"
import { setTimer, type SetTimer } from "@opcode/core/refresh"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { defaultSettings, newer, readSettings, view, type PullRequestsState, type Settings, type SettingsChange } from "./model"
import type { Remote } from "./rpc"

/** How long to wait before reading again after the server couldn't be reached. */
const RETRY = 30_000

/** The server's pull requests and settings, kept live, with the local clock that ages them. Renders nothing. */
export class PullRequestsClient {
  private readonly current = createSignal<PullRequestsState>()
  /** Changes sent but not yet answered, shown over the server's settings so quick changes build on each other. */
  private readonly pending = createSignal<readonly SettingsChange[]>([])
  /** Why the last call failed, until the next state arrives. */
  private readonly problem = createSignal<string>()
  private readonly clock = createSignal(Date.now())
  private readonly lifetime = new AbortController()
  private readonly sends = createSerialQueue()
  private cancelClock?: () => void
  private cancelRetry?: () => void

  constructor(private readonly remote: Remote, private readonly timer: SetTimer = setTimer) {}

  snapshot = () => this.current[0]()?.snapshot
  error = () => this.problem[0]() ?? this.current[0]()?.error
  refreshing = () => this.current[0]()?.refreshing ?? false
  settings = (): Settings => this.pending[0]().reduce<Settings>((settings, change) => readSettings({ ...settings, ...change }), this.current[0]()?.settings ?? defaultSettings)
  /** Ages are relative to this, so views re-render as time passes. */
  now = () => this.clock[0]()
  /** When the server's next automatic refresh starts. */
  nextRefresh = () => this.current[0]()?.nextRefresh
  /** The snapshot's lists, without the pull requests inactive longer than the ignore setting. */
  view = () => view(this.snapshot(), this.settings().ignoreDays, this.now())

  /** Follows the server's changes, reading the whole state whenever it may have missed one. */
  start(): void {
    const tick = () => { this.clock[1](Date.now()); this.cancelClock = this.timer(tick, 60_000) }
    this.cancelClock = this.timer(tick, 60_000)
    void consumeLive({
      signal: this.lifetime.signal,
      subscribe: (signal) => this.remote.changes(signal),
      handle: (state) => this.apply(state),
      // Changes published while disconnected are gone.
      onReconnect: () => this.read(),
      // Reads report what clients need to know.
      warn: () => {},
    })
    void this.read()
  }

  refresh(): void {
    void this.remote.refresh().then((state) => this.apply(state), (error) => this.failed(error))
  }

  /** Applies at once here, and everywhere once the server has saved it. */
  updateSettings(change: SettingsChange): void {
    this.pending[1]((pending) => [...pending, change])
    void this.sends(async () => {
      try { this.apply(await this.remote.update(change)) }
      catch (error) { await this.failed(error) }
      finally { this.pending[1]((pending) => pending.filter((sent) => sent !== change)) }
    })
  }

  dispose(): void {
    this.lifetime.abort()
    this.cancelClock?.()
    this.cancelRetry?.()
  }

  /** Server states can arrive twice or out of order: once from a call and once from the event, from any location. */
  private apply(state: PullRequestsState) {
    if (this.lifetime.signal.aborted) return
    this.problem[1](undefined)
    if (newer(state, this.current[0]())) this.current[1](state)
  }

  private async read() {
    this.cancelRetry?.()
    try { this.apply(await this.remote.state(this.lifetime.signal)) } catch (error) {
      if (this.lifetime.signal.aborted) return
      this.problem[1](errorMessage(error))
      this.cancelRetry = this.timer(() => void this.read(), RETRY)
    }
  }

  /** A failed call may have missed changes: read them, and say what failed. */
  private async failed(error: unknown) {
    await this.read()
    if (!this.lifetime.signal.aborted) this.problem[1](errorMessage(error))
  }
}

/** Sends the review feedback on the open session's pull request to that session, as your prompt. */
export async function sendFeedback(api: Pick<Context, "client" | "ui">, remote: Pick<Remote, "feedback">, signal: AbortSignal): Promise<void> {
  const route = api.ui.router.current()
  if (route.type !== "session") return api.ui.toast.show({ variant: "warning", message: "Open a session first: /ghpr-comments sends to the open session." })
  const { sessionID } = route
  api.ui.toast.show({ message: "Fetching review comments..." })
  try {
    // The session's directory, not the terminal's, picks the branch; the server reads it there.
    const session = await api.client.session.get({ sessionID }, { signal })
    const { number, text, summary } = await remote.feedback(session.location.directory, signal)
    const title = `PR #${number}`
    if (!text) return api.ui.toast.show({ title, message: `No review comments to send. ${summary}` })
    await api.client.session.prompt({ sessionID, text }, { signal })
    api.ui.toast.show({ variant: "success", title, message: `Sent review comments. ${summary}` })
  } catch (error) {
    if (!signal.aborted) api.ui.toast.show({ variant: "error", title: "Review comments", message: errorMessage(error) })
  }
}
