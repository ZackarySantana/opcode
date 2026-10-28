import { createOverdue, followState } from "@opcode/core/follow"
import { createPending } from "@opcode/core/pending"
import { setTimer, type SetTimer } from "@opcode/core/refresh"
import { describeRpcError } from "@opcode/core/rpc"
import { createClock } from "@opcode/tabs/clock"
import type { OpenCodeClient } from "@opencode/client"
import { createSignal } from "solid-js"
import { defaultSettings, readSettings, view, type PullRequestsState, type Settings, type SettingsChange } from "./model"
import { GhPrStatusRpc, type FormattedFeedback } from "./rpc"

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
  private readonly follower: ReturnType<typeof followState<PullRequestsState>>
  private readonly send: (change: SettingsChange) => Promise<void>
  private readonly overdue = createOverdue()
  private readonly clock: ReturnType<typeof createClock>

  constructor(private readonly remote: Remote, timer: SetTimer = setTimer) {
    this.follower = followState<PullRequestsState>({
      read: (signal) => remote.state(signal),
      changes: (signal) => remote.changes(signal),
      apply: (state) => this.current[1]({ state, ...state.nextRefreshIn === undefined ? {} : { nextRefresh: Date.now() + state.nextRefreshIn } }),
      problem: (message) => this.problem[1](message),
      describe: describeError,
      timer,
    })
    this.send = createPending({ send: remote.update, answered: this.follower.offer, failed: this.follower.failed, changed: this.pending[1] })
    // A refresh long overdue means news stopped, such as when the server unloaded the plugin from every location:
    // reading again starts it there.
    this.clock = createClock({ timer, tick: (at) => { if (this.overdue(this.nextRefresh(), this.refreshing(), at)) void this.follower.resync() } })
  }

  snapshot = () => this.current[0]()?.state.snapshot
  error = () => this.problem[0]() ?? this.current[0]()?.state.error
  refreshing = () => this.current[0]()?.state.refreshing ?? false
  settings = (): Settings => this.pending[0]().reduce<Settings>((settings, change) => readSettings({ ...settings, ...change }), this.current[0]()?.state.settings ?? defaultSettings)
  /** Ages are relative to this, so views re-render as time passes. */
  now = () => this.clock.now()
  /** When the server's next automatic refresh starts, on this terminal's clock. */
  nextRefresh = () => this.current[0]()?.nextRefresh
  /** The snapshot's lists, without the pull requests inactive longer than the ignore setting. */
  view = () => view(this.snapshot(), this.settings().ignoreDays, this.now())

  /** Follows the server's changes, reading the whole state whenever it may have missed one. */
  start(): void {
    this.follower.start()
  }

  refresh(): void {
    void this.remote.refresh().then(this.follower.offer, this.follower.failed)
  }

  /** Applies at once here, and everywhere once the server has saved it. */
  updateSettings(change: SettingsChange): void {
    void this.send(change)
  }

  dispose(): void {
    this.follower.dispose()
    this.clock.dispose()
  }
}
