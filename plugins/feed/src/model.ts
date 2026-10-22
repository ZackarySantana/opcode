import type { Feed } from "./parse"
import type { FeedKind, Preset } from "./presets"
import type { Subscription } from "./sqlite"
import { inProgress, interpret, type Phase } from "./status"

export type FetchResult =
  | { readonly status: "loading"; readonly feed?: Feed }
  | { readonly status: "ok"; readonly feed: Feed; readonly fetchedAt: number }
  | { readonly status: "error"; readonly error: string; readonly feed?: Feed }

/** Where resolved and completed items appear. */
export type ResolvedScope = "both" | "sidebar" | "feed" | "none"
/** The two places a timeline renders. */
export type Surface = "sidebar" | "feed"

export interface Settings {
  readonly windowHours: number
  readonly resolved: ResolvedScope
}

export const defaultSettings: Settings = { windowHours: 12, resolved: "none" }
export const windowChoices = [6, 12, 24, 48, 72, 168] as const
export const resolvedChoices: readonly ResolvedScope[] = ["both", "sidebar", "feed", "none"]

export const showsResolved = (scope: ResolvedScope, surface: Surface) => scope === "both" || scope === surface
/** In-progress items stay visible past the window, but not forever if a provider never closes one. */
const CURRENT_HORIZON = 7 * 24 * 60 * 60_000
/** Newest posts each updates feed may place in a timeline. */
export const UPDATES_PER_FEED = 3
/** Items shown when the timeline is narrowed to one feed. */
export const FEED_HISTORY = 20

export interface TimelineEntry {
  readonly key: string
  readonly url: string
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
  readonly unreachable: readonly { readonly source: string; readonly error: string }[]
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
const kindOf = (subscription: Subscription, presets: readonly Preset[]) => presets.find((preset) => preset.url === subscription.url)?.kind ?? subscription.kind

export const kindTitles: Record<FeedKind, string> = { status: "STATUS PAGES", updates: "UPDATES" }
export const kinds: readonly FeedKind[] = ["status", "updates"]

/** Status pages, then updates; within each, custom subscriptions first, then presets in catalog order. */
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

/** Every whitespace-separated word of the query must appear in the text, case-insensitively. */
export function matchesText(text: string, query: string): boolean {
  const haystack = text.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word))
}

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
  readonly updatesPerFeed?: number
  /**
   * Narrows to one subscribed feed and shows its history: the window, the updates cap, and the
   * resolved setting stop applying, and the newest FEED_HISTORY settled items are kept.
   */
  readonly feed?: string
}

/** One timeline across every subscribed feed, or one feed's history. */
export function timeline(subscriptions: readonly Subscription[], presets: readonly Preset[], results: ReadonlyMap<string, FetchResult>, settings: Settings, surface: Surface,
  { now = Date.now(), updatesPerFeed = UPDATES_PER_FEED, feed }: TimelineOptions = {}): Timeline {
  const scoped = feed !== undefined
  const resolved = scoped || showsResolved(settings.resolved, surface)
  const current: TimelineEntry[] = []
  const recent: TimelineEntry[] = []
  const upcoming: TimelineEntry[] = []
  const operational: string[] = []
  const unreachable: { source: string; error: string }[] = []
  let pending = 0
  const span = scoped ? Infinity : settings.windowHours * 60 * 60_000
  const cap = scoped ? FEED_HISTORY : updatesPerFeed
  for (const subscription of scoped ? subscriptions.filter((subscription) => subscription.url === feed) : subscriptions) {
    const result = results.get(subscription.url)
    const source = feedTitle(subscription.url, presets, subscription, result)
    if (result?.status === "error") unreachable.push({ source, error: result.error })
    if (!result?.feed) { if (result?.status !== "error") pending++; continue }
    const kind = kindOf(subscription, presets)
    let busy = false
    const posts: TimelineEntry[] = []
    for (const item of result.feed.items) {
      if (item.published === undefined) continue
      const meaning = interpret(item, kind)
      const entry = { key: `${subscription.url}\n${item.id}`, url: subscription.url, source, link: item.link, time: item.published, ...meaning }
      if (inProgress(meaning.phase)) {
        if (item.published < now - CURRENT_HORIZON) continue
        busy = true
        current.push(entry)
      } else if (item.published > now) {
        if (item.published <= now + span) upcoming.push(entry)
      } else if (item.published >= now - span && (resolved || meaning.phase !== "resolved")) {
        if (kind === "updates") posts.push(entry)
        else recent.push(entry)
      }
    }
    // A busy updates feed cannot bury incidents: only its newest few posts count.
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

/** The sidebar's budget: a few timeline entries, then the soonest scheduled work. */
export function sidebarLayout(view: Timeline, limits = { entries: 5, upcoming: 2 }): SidebarLayout {
  const entries = [...view.current, ...view.recent]
  return {
    entries: entries.slice(0, limits.entries),
    hiddenEntries: Math.max(0, entries.length - limits.entries),
    upcoming: view.upcoming.slice(0, limits.upcoming),
    hiddenUpcoming: Math.max(0, view.upcoming.length - limits.upcoming),
  }
}

/** One-line state of a single feed for the subscription editor. */
export function feedState(result: FetchResult | undefined, kind: FeedKind, now = Date.now()): { text: string; phase?: Phase } {
  if (!result) return { text: "" }
  if (result.status === "loading" && !result.feed) return { text: "fetching…" }
  if (result.status === "error") return { text: `error: ${result.error}`, phase: "active" }
  const items = result.feed!.items.map((item) => ({ item, meaning: interpret(item, kind) }))
  if (kind === "status") {
    const live = items.find(({ item, meaning }) => inProgress(meaning.phase) && (item.published ?? 0) >= now - CURRENT_HORIZON)
    return live ? { text: `${live.meaning.status ?? "Ongoing"}: ${live.meaning.title}`, phase: live.meaning.phase } : { text: "operational", phase: "resolved" }
  }
  const latest = items[0]
  return latest ? { text: `${age(latest.item.published, now)} ${latest.meaning.title}`.trim(), phase: "news" } : { text: "no items" }
}

export function age(time: number | undefined, now = Date.now()): string {
  if (time === undefined) return ""
  const minutes = Math.max(0, Math.floor((now - time) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  // Past a day: days plus leftover hours, e.g. "1d 5h"; whole days drop the "0h".
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours / 24}d`
}

export function relative(time: number, now = Date.now()): string {
  return time > now ? `in ${age(now, time)}` : `${age(time, now)} ago`
}

export function windowShort(hours: number): string {
  return hours % 24 === 0 && hours > 24 ? `${hours / 24}d` : `${hours}h`
}

export function windowLabel(hours: number): string {
  return hours % 24 === 0 && hours > 24 ? `${hours / 24} days` : `${hours} hours`
}
