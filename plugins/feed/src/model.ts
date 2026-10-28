import type { Versioned } from "@opcode/core/follow"
import { age, matchesText } from "@opcode/tabs/format"
import type { Feed } from "./parse"
import { feedURL, type FeedKind, type Preset } from "./presets"
import { inProgress, interpret, type Interpretation, type Phase } from "./status"

export const PLUGIN_ID = "opcode-feed"

export interface Subscription {
  readonly url: string
  /** The feed's own title, learned on the first successful fetch. */
  readonly title?: string
  readonly kind: FeedKind
  readonly createdAt: number
}

/** A feed item, read as its feed's kind. */
export interface Post extends Interpretation {
  readonly id: string
  readonly link?: string
  /** Epoch milliseconds, when the feed provides a parseable date. */
  readonly published?: number
}

/** A fetched feed, its items read once where it's fetched rather than shipped as markup. */
export interface Posts {
  readonly title?: string
  readonly items: readonly Post[]
}

export function readPosts(feed: Feed, kind: FeedKind): Posts {
  return { title: feed.title, items: feed.items.map((item) => ({ id: item.id, link: item.link, published: item.published, ...interpret(item, kind) })) }
}

export type FetchResult =
  | { readonly status: "loading"; readonly feed?: Posts }
  | { readonly status: "ok"; readonly feed: Posts }
  | { readonly status: "error"; readonly error: string; readonly feed?: Posts }

/** Which surfaces show resolved incidents. */
export type SurfaceScope = "both" | "sidebar" | "feed" | "none"
/** The two places a timeline renders. */
export type Surface = "sidebar" | "feed"

export interface Settings {
  readonly windowHours: number
  readonly resolved: SurfaceScope
  /** Posts from release feeds always show in /feed; by default the sidebar is kept for incidents. */
  readonly sidebarReleases: boolean
  /** Timeline entries the sidebar lists before pointing to /feed. */
  readonly sidebarItems: number
  /** Minutes between automatic refreshes, which also retry unreachable feeds. */
  readonly refreshMinutes: number
}

export const defaultSettings: Settings = { windowHours: 12, resolved: "none", sidebarReleases: false, sidebarItems: 5, refreshMinutes: 10 }
export const windowChoices: readonly number[] = [6, 12, 24, 48, 72, 168]
export const refreshChoices: readonly number[] = [1, 5, 10, 15, 30, 60]
export const scopeChoices: readonly SurfaceScope[] = ["both", "sidebar", "feed", "none"]
export const sidebarItemChoices: readonly number[] = [3, 5, 10, 15, 20]

const fieldChoices: { readonly [Key in keyof Settings]: readonly Settings[Key][] } = {
  windowHours: windowChoices, resolved: scopeChoices, sidebarReleases: [false, true], sidebarItems: sidebarItemChoices, refreshMinutes: refreshChoices,
}

/** The fields of `value` that are one of their choices; anything else is left out. */
export function readChange(value: unknown): Partial<Settings> {
  const input: Record<string, unknown> = value && typeof value === "object" ? { ...value } : {}
  const change: Record<string, unknown> = {}
  for (const [key, choices] of Object.entries(fieldChoices)) if ((choices as readonly unknown[]).includes(input[key])) change[key] = input[key]
  return change
}

/** Settings from stored JSON, whatever its shape: each field that isn't one of its choices keeps its default. */
export function readSettings(stored: unknown): Settings {
  return { ...defaultSettings, ...readChange(stored) }
}

export const kinds: readonly FeedKind[] = ["status", "release"]

/** Subscriptions from stored JSON, whatever its shape: entries without an http(s) URL or a kind are left out, as are repeats. */
export function readSubscriptions(stored: unknown): Subscription[] {
  const subscriptions = new Map<string, Subscription>()
  for (const entry of Array.isArray(stored) ? stored as unknown[] : []) {
    if (!entry || typeof entry !== "object") continue
    const { url, title, kind, createdAt } = entry as Record<string, unknown>
    if (typeof url !== "string" || !kinds.includes(kind as FeedKind)) continue
    let href: string
    try { href = feedURL(url) } catch { continue }
    if (subscriptions.has(href)) continue
    subscriptions.set(href, { url: href, kind: kind as FeedKind, createdAt: typeof createdAt === "number" ? createdAt : 0, ...typeof title === "string" && title ? { title } : {} })
  }
  return [...subscriptions.values()]
}

/** What the server shares with every client: settings, subscriptions, each one's latest fetch, and when the next starts. */
export interface FeedsState extends Versioned {
  readonly settings: Settings
  /** In the order they were added. */
  readonly subscriptions: readonly Subscription[]
  /** Each subscription's latest fetch, by URL. */
  readonly results: { readonly [url: string]: FetchResult }
  /** How long until the next automatic refresh when the state was made: clients count from receipt, whatever their clock. */
  readonly nextRefreshIn?: number
  /** Why the saved subscriptions and settings can't be read, while they can't. */
  readonly error?: string
}

const showsOn = (scope: SurfaceScope, surface: Surface) => scope === "both" || scope === surface
/** In-progress items stay visible past the window, but not forever if a provider never closes one. */
const CURRENT_HORIZON = 7 * 24 * 60 * 60_000
/** Newest posts each release feed may place in a timeline. */
export const RELEASES_PER_FEED = 3
/** Items shown when the timeline is narrowed to one feed. */
export const FEED_HISTORY = 20

export interface TimelineEntry {
  readonly key: string
  readonly url: string
  readonly kind: FeedKind
  readonly source: string
  readonly title: string
  readonly phase: Phase
  readonly status?: string
  readonly summary?: string
  readonly link?: string
  readonly time: number
}

export interface Timeline {
  /** In progress, newest first. */
  readonly current: readonly TimelineEntry[]
  /** Everything else inside the window, newest first. */
  readonly recent: readonly TimelineEntry[]
  /** Future-dated items (scheduled maintenance) starting within the window, soonest first. */
  readonly upcoming: readonly TimelineEntry[]
  /** Status feeds with nothing in progress. */
  readonly operational: readonly string[]
  readonly unreachable: readonly { readonly source: string; readonly error: string; readonly kind: FeedKind }[]
  /** Subscriptions still waiting for their first response. */
  readonly pending: number
}

export interface ManagerRow {
  readonly url: string
  readonly title: string
  readonly kind: FeedKind
  readonly subscribed: boolean
  readonly preset: boolean
  readonly result?: FetchResult
}

const host = (url: string) => { try { return new URL(url).host } catch { return url } }

export function feedTitle(url: string, presets: readonly Preset[], subscription?: Subscription, result?: FetchResult) {
  return presets.find((preset) => preset.url === url)?.title ?? subscription?.title ?? result?.feed?.title ?? host(url)
}

/** A preset's kind is authoritative; a custom feed keeps the kind chosen when it was added. */
export const kindOf = (subscription: Subscription, presets: readonly Preset[]) => presets.find((preset) => preset.url === subscription.url)?.kind ?? subscription.kind

export const kindTitles: Record<FeedKind, string> = { status: "STATUS PAGES", release: "RELEASES" }

/** Status pages, then release feeds; within each, custom subscriptions first, then presets in catalog order. */
export function managerRows(subscriptions: readonly Subscription[], presets: readonly Preset[], results: ReadonlyMap<string, FetchResult>): ManagerRow[] {
  const subscribed = new Map(subscriptions.map((subscription) => [subscription.url, subscription]))
  const custom = subscriptions.filter((subscription) => !presets.some((preset) => preset.url === subscription.url))
  const rows = [
    ...custom.map((subscription) => ({ url: subscription.url, kind: subscription.kind, preset: false })),
    ...presets.map((preset) => ({ url: preset.url, kind: preset.kind, preset: true })),
  ].map(({ url, kind, preset }) => ({
    url, kind, preset,
    title: feedTitle(url, presets, subscribed.get(url), results.get(url)),
    subscribed: subscribed.has(url),
    result: results.get(url),
  }))
  return kinds.flatMap((kind) => rows.filter((row) => row.kind === kind))
}

export type EditRow =
  | { readonly kind: "heading"; readonly title: string }
  | { readonly kind: "add"; readonly url: string; readonly feedKind: FeedKind }
  | ({ readonly kind: "feed"; readonly feedKind: FeedKind } & Omit<ManagerRow, "kind">)

/**
 * The editor's box filters feeds under a heading per kind. Given a new URL, it first offers to add it
 * as either kind, since the kind decides how its items are read.
 */
export function editRows(rows: readonly ManagerRow[], query: string, candidate: string | undefined): EditRow[] {
  const add: EditRow[] = candidate && !rows.some((row) => row.url === candidate)
    ? kinds.map((feedKind) => ({ kind: "add", url: candidate, feedKind }))
    : []
  const matching = rows.filter((row) => matchesText(`${row.title} ${row.url}`, query))
  return [...add, ...kinds.flatMap((kind): EditRow[] => {
    const group = matching.filter((row) => row.kind === kind)
    return group.length ? [{ kind: "heading", title: kindTitles[kind] }, ...group.map(({ kind: feedKind, ...row }) => ({ kind: "feed" as const, feedKind, ...row }))] : []
  })]
}

export interface TimelineOptions {
  readonly now?: number
  readonly releasesPerFeed?: number
  /**
   * Narrows to one subscribed feed and shows its history: the window, the release cap, and the
   * resolved setting stop applying, and the newest FEED_HISTORY settled items are kept.
   */
  readonly feed?: string
}

/** One timeline across every subscribed feed, or one feed's history. */
export function timeline(subscriptions: readonly Subscription[], presets: readonly Preset[], results: ReadonlyMap<string, FetchResult>, settings: Pick<Settings, "windowHours" | "resolved" | "sidebarReleases">, surface: Surface,
  { now = Date.now(), releasesPerFeed = RELEASES_PER_FEED, feed }: TimelineOptions = {}): Timeline {
  const scoped = feed !== undefined
  const resolved = scoped || showsOn(settings.resolved, surface)
  const releases = surface === "feed" || settings.sidebarReleases
  const current: TimelineEntry[] = []
  const recent: TimelineEntry[] = []
  const upcoming: TimelineEntry[] = []
  const operational: string[] = []
  const unreachable: { source: string; error: string; kind: FeedKind }[] = []
  let pending = 0
  const span = scoped ? Infinity : settings.windowHours * 60 * 60_000
  const cap = scoped ? FEED_HISTORY : releasesPerFeed
  for (const subscription of scoped ? subscriptions.filter((subscription) => subscription.url === feed) : subscriptions) {
    const kind = kindOf(subscription, presets)
    // A release feed kept out of the sidebar leaves no trace there, not even a failure.
    if (kind === "release" && !releases) continue
    const result = results.get(subscription.url)
    const source = feedTitle(subscription.url, presets, subscription, result)
    if (result?.status === "error") unreachable.push({ source, error: result.error, kind })
    if (!result?.feed) { if (result?.status !== "error") pending++; continue }
    let busy = false
    const posts: TimelineEntry[] = []
    for (const { id, published, link, ...meaning } of result.feed.items) {
      if (published === undefined) continue
      const entry = { key: `${subscription.url}\n${id}`, url: subscription.url, kind, source, link, time: published, ...meaning }
      if (inProgress(meaning.phase)) {
        if (published < now - CURRENT_HORIZON) continue
        busy = true
        current.push(entry)
      } else if (published > now) {
        if (published <= now + span) upcoming.push(entry)
      } else if (published >= now - span && (resolved || meaning.phase !== "resolved")) {
        if (kind === "release") posts.push(entry)
        else recent.push(entry)
      }
    }
    // A busy release feed cannot bury incidents: only its newest few posts count.
    recent.push(...posts.sort((a, b) => b.time - a.time).slice(0, cap))
    // A status page with nothing in progress is operational, including an empty one (Azure).
    if (kind === "status" && !busy) operational.push(source)
  }
  const newest = (a: TimelineEntry, b: TimelineEntry) => b.time - a.time
  return { current: current.sort(newest), recent: recent.sort(newest).slice(0, scoped ? FEED_HISTORY : undefined), upcoming: upcoming.sort((a, b) => a.time - b.time), operational: operational.sort(), unreachable, pending }
}

export function matches(entry: TimelineEntry, query: string): boolean {
  return matchesText([entry.source, entry.status, entry.title, entry.summary].filter(Boolean).join(" "), query)
}

export interface SidebarLayout {
  readonly entries: readonly TimelineEntry[]
  readonly hiddenEntries: number
  readonly upcoming: readonly TimelineEntry[]
  readonly hiddenUpcoming: number
}

/** The sidebar's budget: up to `limit` timeline entries, then the two soonest scheduled items. */
export function sidebarLayout(view: Timeline, limit: number): SidebarLayout {
  const entries = [...view.current, ...view.recent]
  return {
    entries: entries.slice(0, limit),
    hiddenEntries: Math.max(0, entries.length - limit),
    upcoming: view.upcoming.slice(0, 2),
    hiddenUpcoming: Math.max(0, view.upcoming.length - 2),
  }
}

/** Where a single feed stands, for each front end to word: its in-progress item, or a release feed's newest. */
export type FeedCondition =
  | { readonly kind: "none" }
  | { readonly kind: "fetching" }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "live"; readonly item: Post }
  | { readonly kind: "operational" }
  | { readonly kind: "latest"; readonly item: Post }
  | { readonly kind: "empty" }

export function feedCondition(result: FetchResult | undefined, kind: FeedKind, now = Date.now()): FeedCondition {
  if (!result) return { kind: "none" }
  if (result.status === "loading" && !result.feed) return { kind: "fetching" }
  if (result.status === "error") return { kind: "error", error: result.error }
  const items = result.feed!.items
  if (kind === "status") {
    const live = items.find((item) => inProgress(item.phase) && (item.published ?? 0) >= now - CURRENT_HORIZON)
    return live ? { kind: "live", item: live } : { kind: "operational" }
  }
  return items[0] ? { kind: "latest", item: items[0] } : { kind: "empty" }
}

/** One-line state of a single feed for the subscription editor. */
export function feedState(result: FetchResult | undefined, kind: FeedKind, now = Date.now()): { text: string; phase?: Phase } {
  const condition = feedCondition(result, kind, now)
  switch (condition.kind) {
    case "none": return { text: "" }
    case "fetching": return { text: "fetching…" }
    case "error": return { text: `error: ${condition.error}`, phase: "active" }
    case "live": return { text: `${condition.item.status ?? "Ongoing"}: ${condition.item.title}`, phase: condition.item.phase }
    case "operational": return { text: "operational", phase: "resolved" }
    case "latest": return { text: `${age(condition.item.published, now)} ${condition.item.title}`.trim(), phase: "news" }
    case "empty": return { text: "no items" }
  }
}

export function windowShort(hours: number): string {
  return hours % 24 === 0 && hours > 24 ? `${hours / 24}d` : `${hours}h`
}

export function windowLabel(hours: number): string {
  return hours % 24 === 0 && hours > 24 ? `${hours / 24} days` : `${hours} hours`
}
