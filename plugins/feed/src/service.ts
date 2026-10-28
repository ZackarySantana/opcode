import { errorMessage } from "@opcode/core"
import { failover, joinShared, packageVersion } from "@opcode/core/process"
import { setTimer } from "@opcode/core/refresh"
import { toJson, type Json } from "@opcode/core/rpc"
import { createSchedule, type Schedule } from "@opcode/core/schedule"
import { fetchFeed, type Fetcher, type FetchOptions } from "./fetch"
import { kindOf, PLUGIN_ID, readPosts, readSettings, readSubscriptions, type FeedsState, type FetchResult, type Settings, type Subscription } from "./model"
import { feedURL, presets, type FeedKind } from "./presets"

/** How long to wait before reading the saved feeds again after a read failed. */
const LOAD_RETRY = 10_000
/** How long changes gather before they're announced, so a refresh of many feeds isn't announced feed by feed. */
const ANNOUNCE_DELAY = 100

/** Where each part is saved in plugin storage. */
export type StorageKey = "settings" | "subscriptions"

/** What the service needs from its host: plugin storage, and a way to reach every client. */
export interface Ports {
  /** A saved value as stored, of any shape. */
  load(key: StorageKey): Promise<unknown>
  save(key: StorageKey, value: Json): Promise<void>
  publish(state: FeedsState): Promise<void>
}

/** Runs changes to plugin storage one at a time. */
export type Writes = <T>(operation: () => Promise<T>) => Promise<T>

interface Saved {
  readonly settings: Settings
  readonly subscriptions: readonly Subscription[]
}

/**
 * The feeds every client shows: the saved subscriptions and settings, and each feed's latest fetch on the settings'
 * schedule. Every change reads what's saved and changes that, through `writes`, which every version of the plugin in the
 * process shares: while an upgrade runs two versions' services, neither saves its own copy over the other's changes.
 */
export class FeedsService {
  private settings: Settings = readSettings(undefined)
  private subscriptions: readonly Subscription[] = []
  /** Whether the saved feeds were read. Until then nothing is fetched, and nothing may be saved. */
  private loaded = false
  private loadError?: string
  private readonly results = new Map<string, FetchResult>()
  /** The latest fetch of each feed; starting another, or unsubscribing, aborts it. */
  private readonly requests = new Map<string, AbortController>()
  private readonly lifetime = new AbortController()
  private revision = 0
  private cancelLoad?: () => void
  private cancelAnnounce?: () => void
  private readonly server = crypto.randomUUID()
  private readonly started = Date.now()
  private readonly schedule: Schedule
  private readonly fetching: FetchOptions
  /** Settles once the saved feeds were read, or failed to be. */
  readonly ready: Promise<void>

  constructor(private readonly ports: Ports, private readonly writes: Writes, private readonly fetcher: Fetcher, options: Partial<FetchOptions> = {}) {
    this.fetching = { timeout: 15_000, retryDelays: [2_000, 5_000], timer: setTimer, ...options }
    this.schedule = createSchedule(() => this.refresh(), () => this.settings.refreshMinutes, { timer: this.fetching.timer })
    this.ready = this.load()
  }

  state(): FeedsState {
    const next = this.schedule.next()
    const results = Object.fromEntries(this.subscriptions.flatMap(({ url }) => { const result = this.results.get(url); return result ? [[url, result]] : [] }))
    return {
      server: this.server, started: this.started, revision: this.revision, settings: this.settings, subscriptions: this.subscriptions, results,
      ...next === undefined ? {} : { nextRefreshIn: next - Date.now() }, ...this.loadError ? { error: this.loadError } : {},
    }
  }

  /** Fetches every feed now; every refresh, automatic or not, restarts the countdown. Before the saved feeds are read, tries reading them. */
  refresh(): void {
    if (this.lifetime.signal.aborted) return
    if (!this.loaded) return void this.load()
    this.schedule.restart()
    for (const { url } of this.subscriptions) void this.fetch(url)
  }

  update(change: Partial<Settings>): Promise<FeedsState> {
    return this.change(async (saved) => {
      const settings = readSettings({ ...saved.settings, ...change })
      await this.ports.save("settings", toJson(settings))
      return { ...saved, settings }
    })
  }

  /** Adds the feed, unless it's already there, and fetches it. */
  subscribe(url: string, kind: FeedKind): Promise<FeedsState> {
    const href = feedURL(url)
    return this.change(async (saved) => saved.subscriptions.some((subscription) => subscription.url === href) ? saved
      : this.saveSubscriptions(saved, [...saved.subscriptions, { url: href, kind, createdAt: Date.now() }]))
  }

  unsubscribe(url: string): Promise<FeedsState> {
    return this.change(async (saved) => saved.subscriptions.some((subscription) => subscription.url === url)
      ? this.saveSubscriptions(saved, saved.subscriptions.filter((subscription) => subscription.url !== url)) : saved)
  }

  dispose(): void {
    this.lifetime.abort()
    this.cancelLoad?.()
    this.cancelAnnounce?.()
    this.schedule.dispose()
  }

  /**
   * Reads what's saved, changes it, and applies the result. While the saved feeds can't be read, changes are refused:
   * saving would replace them.
   */
  private change(change: (saved: Saved) => Promise<Saved>): Promise<FeedsState> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error("Feeds stopped on the server"))
    return this.writes(async () => {
      if (this.lifetime.signal.aborted) throw new Error("Feeds stopped on the server")
      let saved: Saved
      try { saved = await this.read() } catch (error) {
        throw new Error(`The saved feeds can't be read right now, so they can't be changed. Try again shortly. (${errorMessage(error)})`)
      }
      // Another version may have saved changes meanwhile; they show even if this one can't be saved.
      this.apply(saved)
      const next = await change(saved)
      if (next !== saved) this.apply(next)
      return this.state()
    })
  }

  private async saveSubscriptions(saved: Saved, subscriptions: readonly Subscription[]): Promise<Saved> {
    await this.ports.save("subscriptions", subscriptions.map(toJson))
    return { ...saved, subscriptions }
  }

  private async read(): Promise<Saved> {
    const [settings, subscriptions] = await Promise.all([this.ports.load("settings"), this.ports.load("subscriptions")])
    return { settings: readSettings(settings), subscriptions: readSubscriptions(subscriptions) }
  }

  /** Reads the saved feeds, through the writes so a change can't land between the read and its use; on failure, tries again on a timer. */
  private load(): Promise<void> {
    return this.writes(async () => {
      if (this.loaded || this.lifetime.signal.aborted) return
      try { this.apply(await this.read()) } catch (error) {
        if (this.lifetime.signal.aborted) return
        console.warn(`${PLUGIN_ID}: can't read the saved feeds, trying again shortly: ${errorMessage(error)}`)
        this.loadError = `The saved feeds can't be read right now: ${errorMessage(error)}`
        this.cancelLoad?.()
        this.cancelLoad = this.fetching.timer(() => void this.load(), LOAD_RETRY)
        this.changed()
      }
    })
  }

  /** Takes what's saved as current: fetches added feeds, drops removed ones, and starts the schedule on the first. */
  private apply(saved: Saved) {
    if (this.lifetime.signal.aborted) return
    const first = !this.loaded
    const before = new Set(this.subscriptions.map(({ url }) => url))
    const after = new Set(saved.subscriptions.map(({ url }) => url))
    this.loaded = true
    this.loadError = undefined
    this.cancelLoad?.()
    this.settings = saved.settings
    this.subscriptions = saved.subscriptions
    for (const url of before) if (!after.has(url)) {
      this.requests.get(url)?.abort()
      this.requests.delete(url)
      this.results.delete(url)
    }
    if (first) this.schedule.start()
    else {
      this.schedule.reschedule()
      for (const url of after) if (!before.has(url)) void this.fetch(url)
    }
    this.changed()
  }

  private async fetch(url: string): Promise<void> {
    const subscription = this.subscriptions.find((subscription) => subscription.url === url)
    if (!subscription || this.lifetime.signal.aborted) return
    this.requests.get(url)?.abort()
    const request = new AbortController()
    this.requests.set(url, request)
    const signal = AbortSignal.any([this.lifetime.signal, request.signal])
    const previous = this.results.get(url)?.feed
    this.setResult(url, { status: "loading", ...previous ? { feed: previous } : {} })
    const fetched = await fetchFeed(this.fetcher, url, signal, this.fetching)
    // A newer fetch, an unsubscribe, or stopping supersedes this one.
    if (signal.aborted) return
    this.requests.delete(url)
    if ("error" in fetched) return this.setResult(url, { status: "error", error: fetched.error, ...previous ? { feed: previous } : {} })
    const feed = readPosts(fetched.feed, kindOf(subscription, presets))
    this.setResult(url, { status: "ok", feed })
    if (feed.title && feed.title !== subscription.title) void this.rename(url, feed.title)
  }

  /** Saves the feed's own title, so it shows before the next fetch, and while the feed is unreachable. */
  private async rename(url: string, title: string) {
    try {
      await this.change(async (saved) => saved.subscriptions.some((subscription) => subscription.url === url && subscription.title !== title)
        ? this.saveSubscriptions(saved, saved.subscriptions.map((subscription) => subscription.url === url ? { ...subscription, title } : subscription)) : saved)
    } catch (error) {
      if (!this.lifetime.signal.aborted) console.warn(`${PLUGIN_ID}: could not save the title of ${url}: ${errorMessage(error)}`)
    }
  }

  private setResult(url: string, result: FetchResult) {
    this.results.set(url, result)
    this.changed()
  }

  /** Clients get the full state after changes, gathered for a moment: a refresh changes every feed twice. */
  private changed() {
    if (this.lifetime.signal.aborted) return
    this.revision++
    this.cancelAnnounce ??= setTimer(() => {
      this.cancelAnnounce = undefined
      if (this.lifetime.signal.aborted) return
      void this.ports.publish(this.state()).catch((error) => console.warn(`${PLUGIN_ID}: could not announce a change: ${errorMessage(error)}`))
    }, ANNOUNCE_DELAY)
  }
}

/**
 * The server process's service, which every location instance joins with its own ports. `start` runs only for the
 * first to join. The service uses the oldest member's ports, and the next one's if those fail: plugin storage is the
 * same in every location, and clients receive every location's events.
 */
export function joinService(member: Ports, start: (ports: Ports) => FeedsService) {
  // A different version's service may hold the plugin's place until its locations unload; clients prefer the newer one.
  const { value, leave } = joinShared(`${PLUGIN_ID}.service@${packageVersion(new URL("../package.json", import.meta.url))}`, member, {
    start: (members) => start({
      load: (key) => failover(members, (ports) => ports.load(key)),
      save: (key, value) => failover(members, (ports) => ports.save(key, value)),
      publish: (state) => failover(members, (ports) => ports.publish(state)),
    }),
    stop: (service) => service.dispose(),
  })
  return { service: value, leave }
}
