import { createOverdue, followState } from "@opcode/core/follow"
import { createPending } from "@opcode/core/pending"
import { setTimer, type SetTimer } from "@opcode/core/refresh"
import { describeRpcError } from "@opcode/core/rpc"
import { createClock } from "@opcode/tabs/clock"
import type { OpenCodeClient } from "@opencode/client"
import { createSignal } from "solid-js"
import { defaultSettings, feedTitle, readSettings, timeline, type FeedsState, type FetchResult, type Settings, type Subscription, type Surface } from "./model"
import { presets, type FeedKind } from "./presets"
import { FeedRpc } from "./rpc"

/** The server's feeds, as a terminal reaches them. */
export interface Remote {
  state(signal?: AbortSignal): Promise<FeedsState>
  update(change: Partial<Settings>): Promise<FeedsState>
  subscribe(url: string, kind: FeedKind): Promise<FeedsState>
  unsubscribe(url: string): Promise<FeedsState>
  refresh(): Promise<FeedsState>
  /** Each published state, live only: states published while disconnected are missed. */
  changes(signal: AbortSignal): AsyncIterable<FeedsState>
}

/** The feeds are the same in every location, so calls go to the terminal's current one, through the client of the moment. */
export function createRemote(client: () => Pick<OpenCodeClient, "rpc">, location: () => { directory: string }): Remote {
  const rpc = () => client().rpc(FeedRpc)
  const call = (signal?: AbortSignal) => ({ location: location(), signal })
  return {
    state: async (signal) => await rpc().state({}, call(signal)) as FeedsState,
    update: async (change) => await rpc().update({ settings: change }, call()) as FeedsState,
    subscribe: async (url, kind) => await rpc().subscribe({ url, kind }, call()) as FeedsState,
    unsubscribe: async (url) => await rpc().unsubscribe({ url }, call()) as FeedsState,
    refresh: async () => await rpc().refresh({}, call()) as FeedsState,
    changes: (signal) => ({
      async *[Symbol.asyncIterator]() {
        for await (const event of rpc().events.subscribe("changed", { signal })) yield event.data as unknown as FeedsState
      },
    }),
  }
}

/** Why a call failed, saying what to do when the server doesn't run the plugin's server side. */
export const describeError = (error: unknown) => describeRpcError(error, { name: "Feed", package: "@lidtop/opencode-feed" })

const none: ReadonlyMap<string, FetchResult> = new Map()

/** A change sent to the server. */
type Change =
  | { readonly settings: Partial<Settings> }
  | { readonly subscribe: { readonly url: string; readonly kind: FeedKind } }
  | { readonly unsubscribe: string }

/** The server's feeds, kept live, with the local clock that ages them. Renders nothing. */
export class FeedsClient {
  /** The latest state, its results by URL, and when its next refresh starts on this terminal's clock. */
  private readonly current = createSignal<{ state: FeedsState; results: ReadonlyMap<string, FetchResult>; nextRefresh?: number }>()
  /** Changes sent but not yet answered, shown over the server's state so quick changes build on each other. */
  private readonly pending = createSignal<readonly Change[]>([])
  /** Why the last call failed, until the next state arrives. */
  private readonly problem = createSignal<string>()
  private readonly follower: ReturnType<typeof followState<FeedsState>>
  private readonly send: (change: Change) => Promise<void>
  private readonly overdue = createOverdue()
  private readonly clock: ReturnType<typeof createClock>

  constructor(private readonly remote: Remote, timer: SetTimer = setTimer) {
    this.follower = followState<FeedsState>({
      read: (signal) => remote.state(signal),
      changes: (signal) => remote.changes(signal),
      apply: (state) => this.current[1]({
        state, results: new Map(Object.entries(state.results)),
        ...state.nextRefreshIn === undefined ? {} : { nextRefresh: Date.now() + state.nextRefreshIn },
      }),
      problem: (message) => this.problem[1](message),
      describe: describeError,
      timer,
    })
    this.send = createPending<Change, FeedsState>({
      send: (change) => "settings" in change ? remote.update(change.settings)
        : "subscribe" in change ? remote.subscribe(change.subscribe.url, change.subscribe.kind)
        : remote.unsubscribe(change.unsubscribe),
      answered: this.follower.offer,
      failed: this.follower.failed,
      changed: this.pending[1],
    })
    // A refresh long overdue means news stopped, such as when the server unloaded the plugin from every location:
    // reading again starts it there.
    this.clock = createClock({ timer, tick: (at) => { if (this.overdue(this.nextRefresh(), this.refreshing(), at)) void this.follower.resync() } })
  }

  subscriptions = (): readonly Subscription[] => this.pending[0]().reduce<readonly Subscription[]>((subscriptions, change) => {
    if ("subscribe" in change) return subscriptions.some(({ url }) => url === change.subscribe.url) ? subscriptions : [...subscriptions, { ...change.subscribe, createdAt: Date.now() }]
    if ("unsubscribe" in change) return subscriptions.filter(({ url }) => url !== change.unsubscribe)
    return subscriptions
  }, this.current[0]()?.state.subscriptions ?? [])
  settings = (): Settings => this.pending[0]().reduce<Settings>((settings, change) => "settings" in change ? readSettings({ ...settings, ...change.settings }) : settings,
    this.current[0]()?.state.settings ?? defaultSettings)
  results = (): ReadonlyMap<string, FetchResult> => this.current[0]()?.results ?? none
  /** Why the server can't be reached, or can't read the saved feeds. */
  error = () => this.problem[0]() ?? this.current[0]()?.state.error
  refreshing = () => [...this.results().values()].some((result) => result.status === "loading")
  /** Ages and the time window are relative to this, so views re-render as time passes. */
  now = () => this.clock.now()
  /** When the server's next automatic refresh starts, on this terminal's clock. */
  nextRefresh = () => this.current[0]()?.nextRefresh
  timeline = (surface: Surface, feed?: string) => timeline(this.subscriptions(), presets, this.results(), this.settings(), surface, { now: this.now(), feed })
  title = (url: string) => feedTitle(url, presets, this.subscriptions().find((subscription) => subscription.url === url), this.results().get(url))

  /** Follows the server's changes, reading the whole state whenever it may have missed one. */
  start(): void {
    this.follower.start()
  }

  /** Fetches every feed now, on the server. */
  refresh(): void {
    void this.remote.refresh().then(this.follower.offer, this.follower.failed)
  }

  /** Each change applies at once here, and everywhere once the server has saved it. */
  updateSettings(change: Partial<Settings>): void {
    void this.send({ settings: change })
  }

  subscribe(url: string, kind: FeedKind): void {
    void this.send({ subscribe: { url, kind } })
  }

  unsubscribe(url: string): void {
    void this.send({ unsubscribe: url })
  }

  toggle(url: string, kind: FeedKind): void {
    if (this.subscriptions().some((subscription) => subscription.url === url)) this.unsubscribe(url)
    else this.subscribe(url, kind)
  }

  dispose(): void {
    this.follower.dispose()
    this.clock.dispose()
  }
}
