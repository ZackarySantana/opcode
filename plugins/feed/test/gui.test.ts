import { expect, test } from "bun:test"
import { feedActions, type ActionHost } from "../src/gui/actions"
import { conditionTone, relativeTime, sectionView, subscriptionRows, unsubscribedPresets, windowSpan } from "../src/gui/view"
import { defaultSettings, readPosts, timeline, type FetchResult, type Subscription } from "../src/model"
import type { FeedItem } from "../src/parse"
import { presets, type FeedKind } from "../src/presets"

const now = Date.parse("2026-10-22T12:00:00Z")
const hours = (count: number) => now - count * 60 * 60_000
const incident = (title: string, status: string, time: number, link?: string): FeedItem => ({ id: title, title, link, published: time, content: `<p><strong>${status}</strong> - ${title} details</p>` })

function feeds(list: { url: string; kind: FeedKind; result?: FetchResult | FeedItem[] }[]) {
  const subscriptions: Subscription[] = list.map(({ url, kind }, index) => ({ url, kind, createdAt: index }))
  const results = new Map(list.flatMap(({ url, kind, result }): [string, FetchResult][] => !result ? []
    : Array.isArray(result) ? [[url, { status: "ok", feed: readPosts({ items: result }, kind) }]]
    : [[url, result]]))
  const view = timeline(subscriptions, presets, results, { ...defaultSettings, windowHours: 24 }, "feed", { now })
  return { subscriptions, results, view }
}

const sample = feeds([
  { url: "https://npm.test/rss", kind: "status", result: [incident("Publishing degraded", "Identified", hours(1), "https://npm.test/1"), incident("Old outage", "Resolved", hours(2))] },
  { url: "https://gh.test/rss", kind: "status", result: [incident("Maintenance soon", "Scheduled", hours(-3)), incident("Webhooks", "Monitoring", hours(4))] },
  { url: "https://quiet.test/rss", kind: "status", result: [] },
  { url: "https://down.test/rss", kind: "status", result: { status: "error", error: "HTTP 503" } },
  { url: "https://bun.test/releases", kind: "release", result: [{ id: "v2", title: "Bun v2", published: hours(1) }] },
])
const section = (fixture: ReturnType<typeof feeds>, id: Parameters<typeof sectionView>[2]) => sectionView(fixture.view, fixture.subscriptions, id)

test("Status lists in-progress incidents, then the window's status posts, with operational and unreachable pages", () => {
  const view = section(sample, "status")
  expect(view.groups.map((group) => [group.id, group.rows.map((row) => [row.head, row.detail, row.title, row.tone])])).toEqual([
    ["current", [["Identified", "npm.test", "Publishing degraded", "danger"], ["Monitoring", "gh.test", "Webhooks", "warning"]]],
  ])
  expect(view.groups[0]!.rows[0]!.link).toBe("https://npm.test/1")
  // Resolved incidents stay out by default, as in the terminal.
  expect(view.operational).toEqual(["quiet.test"])
  expect(view.unreachable).toEqual([{ source: "down.test", error: "HTTP 503" }])
  expect(view.empty).toBeUndefined()
})

test("Upcoming lists scheduled items and Releases lists release posts, each without the other's", () => {
  const upcoming = section(sample, "upcoming")
  expect(upcoming.groups).toMatchObject([{ id: "upcoming", rows: [{ title: "Maintenance soon", tone: "info" }] }])
  expect(upcoming).toMatchObject({ operational: [], unreachable: [] })
  const releases = section(sample, "releases")
  expect(releases.groups).toMatchObject([{ id: "recent", rows: [{ head: "bun.test", title: "Bun v2", tone: "accent" }] }])
  expect(releases.unreachable).toEqual([])
})

test("an empty section says whether nothing is subscribed, still loading, or quiet", () => {
  expect(section(feeds([]), "releases").empty).toBe("unsubscribed")
  expect(section(feeds([{ url: "https://npm.test/rss", kind: "status", result: { status: "loading" } }]), "status").empty).toBe("loading")
  expect(section(feeds([{ url: "https://npm.test/rss", kind: "status", result: [] }]), "upcoming").empty).toBe("quiet")
})

test("subscriptions list each feed's condition, and subscribing offers only presets not yet subscribed", () => {
  const preset = presets[0]!
  const fixture = feeds([
    { url: "https://down.test/rss", kind: "status", result: { status: "error", error: "HTTP 503" } },
    { url: preset.url, kind: "status", result: [incident("Broken", "Identified", hours(1))] },
    { url: "https://bun.test/releases", kind: "release", result: [] },
  ])
  const rows = subscriptionRows(fixture.subscriptions, fixture.results, now)
  expect(rows.map((row) => [row.title, row.kind, row.preset, row.condition.kind, conditionTone(row.condition)])).toEqual([
    ["down.test", "status", false, "error", "danger"],
    [preset.title, "status", true, "live", "danger"],
    ["bun.test", "release", false, "empty", undefined],
  ])
  expect(unsubscribedPresets(fixture.subscriptions).some((option) => option.url === preset.url)).toBe(false)
  expect(unsubscribedPresets([])).toHaveLength(presets.length)
})

test("times read in the interface language, and long windows in days", () => {
  expect(relativeTime(now - 5 * 60_000, now, "en")).toBe("5 minutes ago")
  expect(relativeTime(now + 3 * 60 * 60_000, now, "en")).toBe("in 3 hours")
  expect(relativeTime(now - 2 * 24 * 60 * 60_000, now, "en")).toBe("2 days ago")
  expect(windowSpan(12)).toEqual({ unit: "hours", count: 12 })
  expect(windowSpan(24)).toEqual({ unit: "hours", count: 24 })
  expect(windowSpan(72)).toEqual({ unit: "days", count: 3 })
})

/** A window whose dialogs answer from `answers`, over feeds that record what they were asked to do. */
function host(answers: { select?: unknown[]; prompt?: (string | undefined)[]; confirm?: boolean[] }, state: { subscriptions?: Subscription[]; error?: string } = {}) {
  const toasts: { title: string; variant?: string; description?: string }[] = []
  const calls: string[] = []
  const value: ActionHost = {
    t: (key, params) => params ? `${key} ${JSON.stringify(params)}` : key,
    plural: (key, count) => `${key}:${count}`,
    select: async (options) => {
      calls.push(`select ${options.title}`)
      const answer = answers.select?.shift()
      return typeof answer === "function" ? answer(options.options) : answer as never
    },
    prompt: async () => answers.prompt?.shift(),
    confirm: async () => answers.confirm?.shift() ?? false,
    toast: (toast) => { toasts.push(toast) },
    feeds: {
      subscriptions: () => state.subscriptions ?? [],
      error: () => state.error,
      subscribe: (url, kind) => { calls.push(`subscribe ${url} ${kind}`) },
      unsubscribe: (url) => { calls.push(`unsubscribe ${url}`) },
      refresh: () => { calls.push("refresh") },
    },
  }
  return { value, toasts, calls }
}

const custom = (options: { title: string; value: unknown }[]) => options.find((option) => option.title === "subscribe.custom")!.value

test("subscribing to a preset subscribes it", async () => {
  const preset = presets.find((option) => option.kind === "release")!
  const fake = host({ select: [(options: { value: unknown }[]) => options.find((option) => option.value === preset)!.value] })
  await feedActions(fake.value).subscribe()
  expect(fake.calls).toEqual(["select subscribe.title", `subscribe ${preset.url} release`])
})

test("a custom URL asks for its kind; cancelling any step subscribes nothing", async () => {
  const run = async (answers: Parameters<typeof host>[0]) => {
    const fake = host(answers)
    await feedActions(fake.value).subscribe()
    return fake.calls.filter((call) => call.startsWith("subscribe "))
  }
  const added = host({ select: [custom, "status"], prompt: [" status.example.com/rss "] })
  await feedActions(added.value).subscribe()
  expect(added.calls).toEqual(["select subscribe.title", "select subscribe.kind.title", "subscribe https://status.example.com/rss status"])
  expect(await run({ select: [undefined] })).toEqual([])
  expect(await run({ select: [custom], prompt: [undefined] })).toEqual([])
  expect(await run({ select: [custom, undefined], prompt: ["https://x.test/rss"] })).toEqual([])
})

test("a custom URL that isn't a feed URL, or is already subscribed, says so without asking its kind", async () => {
  const rejected = host({ select: [custom], prompt: ["file:///etc/passwd"] })
  await feedActions(rejected.value).subscribe()
  expect(rejected.toasts).toEqual([{ title: "subscribe.failed", description: "Feeds must use http or https", variant: "error" }])
  const url = "https://x.test/rss"
  const repeated = host({ select: [custom], prompt: [url] }, { subscriptions: [{ url, kind: "status", createdAt: 0 }] })
  await feedActions(repeated.value).subscribe()
  expect(repeated.toasts).toEqual([{ title: `subscribe.already ${JSON.stringify({ title: url })}` }])
  expect([...rejected.calls, ...repeated.calls]).toEqual(["select subscribe.title", "select subscribe.title"])
})

test("unsubscribing asks first", async () => {
  const row = { url: "https://npm.test/rss", title: "npm" }
  const declined = host({ confirm: [false] })
  await feedActions(declined.value).unsubscribe(row)
  expect(declined.calls).toEqual([])
  const confirmed = host({ confirm: [true] })
  await feedActions(confirmed.value).unsubscribe(row)
  expect(confirmed.calls).toEqual([`unsubscribe ${row.url}`])
})

test("refreshing says how many feeds are being fetched, or why there are none to show", () => {
  const subscriptions: Subscription[] = [1, 2, 3].map((index) => ({ url: `https://${index}.test/rss`, kind: "status", createdAt: index }))
  const refreshing = host({}, { subscriptions })
  feedActions(refreshing.value).refresh()
  const none = host({})
  feedActions(none.value).refresh()
  const down = host({}, { error: "Server unavailable" })
  feedActions(down.value).refresh()
  expect([...refreshing.toasts, ...none.toasts, ...down.toasts]).toEqual([
    { title: "refresh.started:3" }, { title: "refresh.none" }, { title: "refresh.failed", description: "Server unavailable", variant: "error" },
  ])
  expect(refreshing.calls).toEqual(["refresh"])
})
