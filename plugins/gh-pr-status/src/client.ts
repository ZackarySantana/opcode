import { createSerialQueue } from "@opcode/core"
import { followState } from "@opcode/core/follow"
import { setTimer, type SetTimer } from "@opcode/core/refresh"
import { describeRpcError } from "@opcode/core/rpc"
import type { OpenCodeClient } from "@opencode/client"
import { createSignal } from "solid-js"
import { defaultSettings, readSettings, view, type PullRequestsState, type Settings, type SettingsChange } from "./model"
import { GhPrStatusRpc, type FormattedFeedback } from "./rpc"

/** How long past its next refresh a state may go without news before the terminal reads again. */
const OVERDUE = 60_000

/** The server's pull request state, as a terminal reaches it. */
export interface Remote {
  state(signal?: AbortSignal): Promise<PullRequestsState>
  update(change: SettingsChange): Promise<PullRequestsState>
  refresh(): Promise<PullRequestsState>
  /** For the branch checked out in `directory` on the server. */
  feedback(directory: string, signal: AbortSignal): Promise<FormattedFeedback>
  /** Each published state, live only: states published while disconnected are missed. */
  changes(signal: AbortSignal): AsyncIterable<PullRequestsState>
}

/**
 * The state is the same in every location, so calls go to the terminal's current one, and feedback to the session's.
 * The client is looked up for each call, since it changes when the server restarts.
 */
export function createRemote(client: () => Pick<OpenCodeClient, "rpc">, location: () => { directory: string }): Remote {
  const rpc = () => client().rpc(GhPrStatusRpc)
  const call = (signal?: AbortSignal) => ({ location: location(), signal })
  return {
    state: async (signal) => await rpc().state({}, call(signal)) as PullRequestsState,
    update: async (change) => await rpc().update({ settings: change }, call()) as PullRequestsState,
    refresh: async () => await rpc().refresh({}, call()) as PullRequestsState,
    feedback: async (directory, signal) => await rpc().feedback({}, { location: { directory }, signal }) as FormattedFeedback,
    changes: (signal) => ({
      async *[Symbol.asyncIterator]() {
        for await (const event of rpc().events.subscribe("changed", { signal })) yield event.data as unknown as PullRequestsState
      },
    }),
  }
}

/** Why a call failed, saying what to do when the server doesn't run the plugin's server side. */
export const describeError = (error: unknown) => describeRpcError(error, { name: "GH PR Status", package: "@lidtop/opencode-gh-pr-status" })

/** The server's pull requests and settings, kept live, with the local clock that ages them. Renders nothing. */
export class PullRequestsClient {
  /** The latest state, and when its next refresh starts on this terminal's clock. */
  private readonly current = createSignal<{ state: PullRequestsState; nextRefresh?: number }>()
  /** Changes sent but not yet answered, shown over the server's settings so quick changes build on each other. */
  private readonly pending = createSignal<readonly SettingsChange[]>([])
  /** Why the last call failed, until the next state arrives. */
  private readonly problem = createSignal<string>()
  private readonly clock = createSignal(Date.now())
  private readonly sends = createSerialQueue()
  private readonly follower: ReturnType<typeof followState<PullRequestsState>>
  private cancelClock?: () => void
  /** The overdue refresh time already read again for, so it is read once. */
  private overdue?: number

  constructor(private readonly remote: Remote, private readonly timer: SetTimer = setTimer) {
    this.follower = followState<PullRequestsState>({
      read: (signal) => remote.state(signal),
      changes: (signal) => remote.changes(signal),
      apply: (state) => this.current[1]({ state, ...state.nextRefreshIn === undefined ? {} : { nextRefresh: Date.now() + state.nextRefreshIn } }),
      problem: (message) => this.problem[1](message),
      describe: describeError,
      timer,
    })
  }

  snapshot = () => this.current[0]()?.state.snapshot
  error = () => this.problem[0]() ?? this.current[0]()?.state.error
  refreshing = () => this.current[0]()?.state.refreshing ?? false
  settings = (): Settings => this.pending[0]().reduce<Settings>((settings, change) => readSettings({ ...settings, ...change }), this.current[0]()?.state.settings ?? defaultSettings)
  /** Ages are relative to this, so views re-render as time passes. */
  now = () => this.clock[0]()
  /** When the server's next automatic refresh starts, on this terminal's clock. */
  nextRefresh = () => this.current[0]()?.nextRefresh
  /** The snapshot's lists, without the pull requests inactive longer than the ignore setting. */
  view = () => view(this.snapshot(), this.settings().ignoreDays, this.now())

  /** Follows the server's changes, reading the whole state whenever it may have missed one. */
  start(): void {
    this.cancelClock = this.timer(() => this.tick(), 60_000)
    this.follower.start()
  }

  refresh(): void {
    void this.remote.refresh().then(this.follower.offer, this.follower.failed)
  }

  /** Applies at once here, and everywhere once the server has saved it. */
  updateSettings(change: SettingsChange): void {
    this.pending[1]((pending) => [...pending, change])
    void this.sends(async () => {
      try { this.follower.offer(await this.remote.update(change)) }
      catch (error) { await this.follower.failed(error) }
      finally { this.pending[1]((pending) => pending.filter((sent) => sent !== change)) }
    })
  }

  dispose(): void {
    this.follower.dispose()
    this.cancelClock?.()
  }

  /**
   * Ages move on each minute. A refresh long overdue means news stopped, such as when the server unloaded the plugin
   * from every location: reading again starts it there.
   */
  private tick() {
    const now = Date.now()
    this.clock[1](now)
    const next = this.nextRefresh()
    if (next !== undefined && next !== this.overdue && !this.refreshing() && now > next + OVERDUE) {
      this.overdue = next
      void this.follower.resync()
    }
    this.cancelClock = this.timer(() => this.tick(), 60_000)
  }
}
