import { feedCondition, kindOf, managerRows, type FeedCondition, type FetchResult, type Subscription, type Timeline, type TimelineEntry } from "../model"
import { presets, type FeedKind } from "../presets"
import type { Phase } from "../status"

export type Section = "status" | "upcoming" | "releases" | "subscriptions"
export const sections: readonly Section[] = ["status", "upcoming", "releases", "subscriptions"]

/** How urgently a row reads; the dialog colors its dot by it. */
export type Tone = "danger" | "warning" | "info" | "muted" | "accent"

export function tone(phase: Phase): Tone {
  switch (phase) {
    case "active": return "danger"
    case "monitoring":
    case "maintenance": return "warning"
    case "scheduled": return "info"
    case "resolved": return "muted"
    case "news": return "accent"
  }
}

export interface Row {
  readonly key: string
  readonly tone: Tone
  /** The provider's status, else the feed's name. */
  readonly head: string
  /** The feed's name, when the head is a status. */
  readonly detail?: string
  readonly title: string
  readonly summary?: string
  readonly link?: string
  readonly time: number
}

export interface Group {
  /** `current` is in progress; `recent` is the time window; `upcoming` is scheduled. */
  readonly id: "current" | "recent" | "upcoming"
  readonly rows: readonly Row[]
}

export interface SectionView {
  readonly groups: readonly Group[]
  /** Status pages with nothing in progress, on the Status section. */
  readonly operational: readonly string[]
  readonly unreachable: readonly { readonly source: string; readonly error: string }[]
  /** Why the section lists nothing: no feeds of its kind, or still fetching them. */
  readonly empty?: "unsubscribed" | "loading" | "quiet"
}

const row = (entry: TimelineEntry): Row => ({
  key: entry.key, tone: tone(entry.phase), head: entry.status ?? entry.source, detail: entry.status ? entry.source : undefined,
  title: entry.title, summary: entry.summary, link: entry.link, time: entry.time,
})

/** Status, Upcoming, and Releases from the feed timeline, grouped as the terminal's tabs group them. */
export function sectionView(view: Timeline, subscriptions: readonly Subscription[], section: Exclude<Section, "subscriptions">): SectionView {
  const kind: FeedKind = section === "releases" ? "release" : "status"
  const ofKind = <T extends { kind: FeedKind }>(items: readonly T[]) => items.filter((item) => item.kind === kind)
  const groups: Group[] = section === "upcoming"
    ? [{ id: "upcoming", rows: view.upcoming.map(row) }]
    : section === "releases"
      ? [{ id: "recent", rows: ofKind(view.recent).map(row) }]
      : [{ id: "current", rows: view.current.map(row) }, { id: "recent", rows: ofKind(view.recent).map(row) }]
  const subscribed = subscriptions.some((subscription) => kindOf(subscription, presets) === kind)
  const listed = groups.some((group) => group.rows.length)
  return {
    groups: groups.filter((group) => group.rows.length),
    operational: section === "status" ? view.operational : [],
    unreachable: section === "upcoming" ? [] : ofKind(view.unreachable).map(({ source, error }) => ({ source, error })),
    empty: listed ? undefined : !subscribed ? "unsubscribed" : view.pending ? "loading" : "quiet",
  }
}

/** A failure reads as urgent; an in-progress incident by its phase. */
export function conditionTone(condition: FeedCondition): Tone | undefined {
  switch (condition.kind) {
    case "error": return "danger"
    case "live": return tone(condition.item.phase)
    default: return undefined
  }
}

export interface SubscriptionRow {
  readonly url: string
  readonly title: string
  readonly kind: FeedKind
  readonly preset: boolean
  readonly condition: FeedCondition
}

/** Subscribed feeds, status pages first, custom feeds first within each kind. */
export function subscriptionRows(subscriptions: readonly Subscription[], results: ReadonlyMap<string, FetchResult>, now: number): SubscriptionRow[] {
  return managerRows(subscriptions, presets, results)
    .filter((row) => row.subscribed)
    .map((row) => ({ url: row.url, title: row.title, kind: row.kind, preset: row.preset, condition: feedCondition(row.result, row.kind, now) }))
}

/** Presets not yet subscribed, to offer when subscribing, in catalog order. */
export function unsubscribedPresets(subscriptions: readonly Subscription[]) {
  const subscribed = new Set(subscriptions.map((subscription) => subscription.url))
  return presets.filter((preset) => !subscribed.has(preset.url))
}

/** The time window, in days when it is a whole number of them past one. */
export const windowSpan = (hours: number) => hours % 24 === 0 && hours > 24 ? { unit: "days" as const, count: hours / 24 } : { unit: "hours" as const, count: hours }

/** "5 minutes ago" or "in 3 hours", in the interface language. */
export function relativeTime(time: number, now: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const minutes = Math.round((time - now) / 60_000)
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return format.format(hours, "hour")
  return format.format(Math.round(hours / 24), "day")
}

export function clockTime(time: number, locale: string): string {
  return new Date(time).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}
