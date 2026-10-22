import { errorMessage } from "@opcode/core"
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

/** Owns subscriptions and in-memory fetch results. Renders nothing. */
export class FeedsController {
  private readonly subscriptionSignal = createSignal<readonly Subscription[]>([])
  private readonly resultSignal = createSignal<ReadonlyMap<string, FetchResult>>(new Map())
  private readonly settingsSignal: Signal<Settings>
  private readonly clock = createSignal(Date.now())
  private readonly lifetime = new AbortController()

  constructor(private readonly database: FeedsDatabase, private readonly fetcher: Fetcher = fetchText, private readonly timeout = 15_000) {
    this.subscriptionSignal[1](database.list())
    this.settingsSignal = createSignal(database.settings())
  }

  subscriptions = () => this.subscriptionSignal[0]()
  results = () => this.resultSignal[0]()
  settings = () => this.settingsSignal[0]()
  /** Ages and the time window are relative to this, so views re-render as time passes. */
  now = () => this.clock[0]()
  timeline = (surface: Surface, feed?: string) => timeline(this.subscriptions(), presets, this.results(), this.settings(), surface, { now: this.now(), feed })
  title = (url: string) => feedTitle(url, presets, this.subscriptions().find((subscription) => subscription.url === url), this.results().get(url))

  tick(now = Date.now()): void {
    this.clock[1](now)
  }

  updateSettings(change: Partial<Settings>): void {
    const next = { ...this.settings(), ...change }
    this.database.saveSettings(next)
    this.settingsSignal[1](next)
  }

  dispose(): void {
    this.lifetime.abort()
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
    this.reload()
    this.setResult(url, undefined)
  }

  toggle(url: string, kind: FeedKind): void {
    if (this.subscriptions().some((subscription) => subscription.url === url)) this.unsubscribe(url)
    else this.subscribe(url, kind)
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.subscriptions().map((subscription) => this.fetch(subscription.url)))
  }

  async fetch(url: string): Promise<void> {
    if (this.lifetime.signal.aborted) return
    const previous: Feed | undefined = this.results().get(url)?.feed
    this.setResult(url, { status: "loading", feed: previous })
    let result: FetchResult
    try {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeout)])
      const feed = parseFeed(await this.fetcher(url, signal))
      result = { status: "ok", feed, fetchedAt: Date.now() }
      if (feed.title) this.database.rename(url, feed.title)
    } catch (error) {
      result = { status: "error", error: errorMessage(error), feed: previous }
    }
    if (this.lifetime.signal.aborted) return
    // An unsubscribe during the fetch wins over its late result.
    if (this.subscriptions().some((subscription) => subscription.url === url)) this.setResult(url, result)
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
