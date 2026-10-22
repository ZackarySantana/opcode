import { errorMessage } from "@opcode/core"
import { setTimer, type SetTimer } from "@opcode/core/refresh"
import { createSchedule, type Schedule } from "@opcode/tabs/schedule"
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
  private readonly schedule: Schedule
  private readonly lifetime = new AbortController()
  /** The latest fetch of each feed; starting another aborts it. */
  private readonly requests = new Map<string, AbortController>()
  private readonly options: Required<FeedsOptions>

  constructor(private readonly database: FeedsDatabase, private readonly fetcher: Fetcher = fetchText, options: FeedsOptions = {}) {
    this.subscriptionSignal[1](database.list())
    this.settingsSignal = createSignal(database.settings())
    this.options = { timeout: 15_000, retryDelays: [2_000, 5_000], timer: setTimer, ...options }
    this.schedule = createSchedule(() => void this.refreshAll(), () => this.settings().refreshMinutes, this.options.timer)
  }

  subscriptions = () => this.subscriptionSignal[0]()
  results = () => this.resultSignal[0]()
  settings = () => this.settingsSignal[0]()
  /** Ages and the time window are relative to this, so views re-render as time passes. */
  now = () => this.schedule.now()
  /** When the next automatic refresh starts; unset until `start`. */
  nextRefresh = () => this.schedule.next()
  refreshing = () => [...this.results().values()].some((result) => result.status === "loading")
  timeline = (surface: Surface, feed?: string) => timeline(this.subscriptions(), presets, this.results(), this.settings(), surface, { now: this.now(), feed })
  title = (url: string) => feedTitle(url, presets, this.subscriptions().find((subscription) => subscription.url === url), this.results().get(url))

  /** Refreshes now, then on the interval setting, with a clock tick each minute. */
  start = () => this.schedule.start()
  tick = (now?: number) => this.schedule.tick(now)

  updateSettings(change: Partial<Settings>): void {
    const next = { ...this.settings(), ...change }
    this.database.saveSettings(next)
    this.settingsSignal[1](next)
    this.schedule.reschedule()
  }

  dispose(): void {
    this.lifetime.abort()
    this.schedule.dispose()
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
    this.schedule.restart()
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
