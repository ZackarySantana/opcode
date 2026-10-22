import { errorMessage } from "@opcode/core"
import { setTimer, type SetTimer } from "@opcode/core/refresh"
import { createSignal, type Signal } from "solid-js"
import { feedTitle, timeline, type FetchResult, type Settings, type Surface } from "./model"
import { parseFeed, type Feed } from "./parse"
import { presets, type FeedKind } from "./presets"
import type { FeedsDatabase, Subscription } from "./sqlite"

export type Fetcher = (url: string, signal: AbortSignal) => Promise<string>

export const fetchText: Fetcher = async (url, signal) => {
  const response = await fetch(url, { signal, headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5" } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

interface FeedsOptions {
  /** Per attempt. */
  readonly timeout?: number
  /** Waits before each retry of a failed fetch; it shows as unreachable once these run out. */
  readonly retryDelays?: readonly number[]
  readonly timer?: SetTimer
}

/** Resolves after `ms`, or as soon as the signal aborts. */
const wait = (timer: SetTimer, ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const cancel = timer(resolve, ms)
  signal.addEventListener("abort", () => { cancel(); resolve() }, { once: true })
})

/** Owns subscriptions, in-memory fetch results, and the refresh schedule. Renders nothing. */
export class FeedsController {
  private readonly subscriptionSignal = createSignal<readonly Subscription[]>([])
  private readonly resultSignal = createSignal<ReadonlyMap<string, FetchResult>>(new Map())
  private readonly settingsSignal: Signal<Settings>
  private readonly clock = createSignal(Date.now())
  private readonly nextSignal = createSignal<number>()
  private readonly lifetime = new AbortController()
  /** The latest fetch of each feed; starting another aborts it. */
  private readonly requests = new Map<string, AbortController>()
  private readonly options: Required<FeedsOptions>
  private cancelNext?: () => void
  private cancelClock?: () => void

  constructor(private readonly database: FeedsDatabase, private readonly fetcher: Fetcher = fetchText, options: FeedsOptions = {}) {
    this.subscriptionSignal[1](database.list())
    this.settingsSignal = createSignal(database.settings())
    this.options = { timeout: 15_000, retryDelays: [2_000, 5_000], timer: setTimer, ...options }
  }

  subscriptions = () => this.subscriptionSignal[0]()
  results = () => this.resultSignal[0]()
  settings = () => this.settingsSignal[0]()
  /** Ages and the time window are relative to this, so views re-render as time passes. */
  now = () => this.clock[0]()
  /** When the next automatic refresh starts; unset until `start`. */
  nextRefresh = () => this.nextSignal[0]()
  refreshing = () => [...this.results().values()].some((result) => result.status === "loading")
  timeline = (surface: Surface, feed?: string) => timeline(this.subscriptions(), presets, this.results(), this.settings(), surface, { now: this.now(), feed })
  title = (url: string) => feedTitle(url, presets, this.subscriptions().find((subscription) => subscription.url === url), this.results().get(url))

  /** Refreshes now, then on the interval setting, with a clock tick each minute. */
  start(): void {
    const tick = () => { this.tick(); this.cancelClock = this.options.timer(tick, 60_000) }
    this.cancelClock = this.options.timer(tick, 60_000)
    void this.refreshAll()
  }

  tick(now = Date.now()): void {
    this.clock[1](now)
    // Timers can fall behind the wall clock across sleep (laptops, WSL); an overdue refresh starts within a tick.
    const next = this.nextRefresh()
    if (next !== undefined && now >= next) void this.refreshAll()
  }

  updateSettings(change: Partial<Settings>): void {
    const next = { ...this.settings(), ...change }
    const reschedule = next.refreshMinutes !== this.settings().refreshMinutes && this.nextRefresh() !== undefined
    this.database.saveSettings(next)
    this.settingsSignal[1](next)
    if (reschedule) this.schedule()
  }

  dispose(): void {
    this.lifetime.abort()
    this.cancelNext?.()
    this.cancelClock?.()
  }

  /** Returns false when the URL was already subscribed. */
  subscribe(url: string, kind: FeedKind): boolean {
    const added = this.database.subscribe(url, kind)
    this.reload()
    if (added) void this.fetch(url)
    return added
  }

  unsubscribe(url: string): void {
    this.database.unsubscribe(url)
    this.requests.get(url)?.abort()
    this.requests.delete(url)
    this.reload()
    this.setResult(url, undefined)
  }

  toggle(url: string, kind: FeedKind): void {
    if (this.subscriptions().some((subscription) => subscription.url === url)) this.unsubscribe(url)
    else this.subscribe(url, kind)
  }

  /** Every refresh, automatic or not, restarts the countdown. */
  async refreshAll(): Promise<void> {
    this.schedule()
    await Promise.all(this.subscriptions().map((subscription) => this.fetch(subscription.url)))
  }

  async fetch(url: string): Promise<void> {
    if (this.lifetime.signal.aborted) return
    this.requests.get(url)?.abort()
    const request = new AbortController()
    this.requests.set(url, request)
    const signal = AbortSignal.any([this.lifetime.signal, request.signal])
    const previous: Feed | undefined = this.results().get(url)?.feed
    this.setResult(url, { status: "loading", feed: previous })
    const result = await this.load(url, signal, previous)
    // A newer fetch, an unsubscribe, or disposal supersedes this one.
    if (signal.aborted) return
    this.requests.delete(url)
    if (result.status === "ok" && result.feed.title) this.database.rename(url, result.feed.title)
    this.setResult(url, result)
  }

  private async load(url: string, signal: AbortSignal, previous: Feed | undefined): Promise<FetchResult> {
    let failure: unknown
    for (const delay of [0, ...this.options.retryDelays]) {
      if (delay) await wait(this.options.timer, delay, signal)
      if (signal.aborted) break
      try {
        return { status: "ok", feed: parseFeed(await this.fetcher(url, AbortSignal.any([signal, AbortSignal.timeout(this.options.timeout)]))), fetchedAt: Date.now() }
      } catch (error) {
        failure = error
      }
    }
    return { status: "error", error: errorMessage(failure), feed: previous }
  }

  private schedule(): void {
    this.cancelNext?.()
    if (this.lifetime.signal.aborted) return
    const delay = this.settings().refreshMinutes * 60_000
    this.nextSignal[1](Date.now() + delay)
    this.cancelNext = this.options.timer(() => void this.refreshAll(), delay)
  }

  private reload(): void {
    this.subscriptionSignal[1](this.database.list())
  }

  private setResult(url: string, result: FetchResult | undefined): void {
    const next = new Map(this.results())
    if (result) next.set(url, result)
    else next.delete(url)
    this.resultSignal[1](next)
  }
}
