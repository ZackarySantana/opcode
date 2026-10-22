import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRoot } from "solid-js"
import type { SetTimer } from "@opcode/core/refresh"
import { FeedsController, type Fetcher } from "../src/host"
import { age, editRows, managerRows, matches, refreshStatus, sidebarLayout, timeline, type EditRow, type FetchResult, type Surface, type SurfaceScope, type TimelineEntry } from "../src/model"
import { launchers, openURL } from "../src/open"
import { parseFeed } from "../src/parse"
import { candidateURL, feedURL, presets } from "../src/presets"
import { FeedsDatabase } from "../src/sqlite"
import { interpret } from "../src/status"

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>npm Status - Incident History</title>
  <link>https://status.npmjs.org</link>
  <item>
    <title>Elevated errors &amp; latency</title>
    <description>&lt;p&gt;Resolved&lt;/p&gt;</description>
    <pubDate>Tue, 20 Oct 2026 10:00:00 +0000</pubDate>
    <link>https://status.npmjs.org/incidents/abc</link>
    <guid>https://status.npmjs.org/incidents/abc</guid>
  </item>
  <item><title><![CDATA[Older <b>incident</b>]]></title><pubDate>Mon, 19 Oct 2026 10:00:00 +0000</pubDate></item>
</channel></rss>`

const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Google Workspace Status Dashboard Updates</title>
  <link href="https://www.google.com/appsstatus/dashboard/" rel="alternate" type="text/html"></link>
  <entry>
    <id>tag:google,1</id>
    <title type="html">Gmail delays</title>
    <updated>2026-10-21T08:00:00+00:00</updated>
    <link rel="self" href="https://example.com/self"/>
    <link rel="alternate" href="https://www.google.com/appsstatus/dashboard/incidents/1"/>
  </entry>
</feed>`

test("parses RSS and Atom titles, links, dates, and escaped text", () => {
  expect(parseFeed(rss)).toEqual({
    title: "npm Status - Incident History",
    items: [
      { id: "https://status.npmjs.org/incidents/abc", title: "Elevated errors & latency", link: "https://status.npmjs.org/incidents/abc", published: Date.parse("2026-10-20T10:00:00Z"), content: "<p>Resolved</p>" },
      { id: "Older incident", title: "Older incident", link: undefined, published: Date.parse("2026-10-19T10:00:00Z") },
    ],
  })
  expect(parseFeed(atom)).toEqual({
    title: "Google Workspace Status Dashboard Updates",
    items: [{ id: "tag:google,1", title: "Gmail delays", link: "https://www.google.com/appsstatus/dashboard/incidents/1", published: Date.parse("2026-10-21T08:00:00Z") }],
  })
  expect(() => parseFeed("<html><body>Not found</body></html>")).toThrow("Not an RSS or Atom feed")
})

test("typed feed URLs default to https and reject other schemes", () => {
  expect(feedURL(" status.npmjs.org/history.rss ")).toBe("https://status.npmjs.org/history.rss")
  expect(() => feedURL("file:///etc/passwd")).toThrow("http or https")
  expect(() => feedURL("not a url")).toThrow("Not a URL")
})

test("manager groups status pages before release feeds, custom feeds first in each", () => {
  const rows = managerRows([
    { url: presets[0]!.url, kind: "status", createdAt: 1 },
    { url: "https://example.com/feed.xml", title: "Example blog", kind: "release", createdAt: 2 },
    { url: "https://status.example.com/rss", kind: "status", createdAt: 3 },
  ], presets, new Map())
  expect(rows[0]).toMatchObject({ url: "https://status.example.com/rss", kind: "status", subscribed: true, preset: false })
  expect(rows[1]).toMatchObject({ url: presets[0]!.url, title: presets[0]!.title, kind: "status", subscribed: true, preset: true })
  const firstRelease = rows.findIndex((row) => row.kind === "release")
  expect(rows.slice(0, firstRelease).every((row) => row.kind === "status")).toBe(true)
  expect(rows[firstRelease]).toMatchObject({ url: "https://example.com/feed.xml", title: "Example blog", preset: false })
  expect(rows.slice(firstRelease).every((row) => row.kind === "release")).toBe(true)
})

const item = (title: string, content: string) => ({ id: title, title, published: 0, content })
const readStatus = (title: string, content: string) => interpret(item(title, content), "status")

test("reads the latest status from Statuspage, incident.io, and Google feeds", () => {
  // Shapes copied from status.npmjs.org, status.openai.com, and Google's dashboards.
  expect(readStatus("Degraded Package Install and Publishing",
    "<p><small>Oct <var data-var='date'>22</var>, 03:07 UTC</small><br><strong>Identified</strong> - The issue has been identified and a fix is being implemented. </p><p><small>Oct 22</small><br><strong>Investigating</strong> - We are currently investigating this issue. </p>"))
    .toEqual({ phase: "active", status: "Identified", title: "Degraded Package Install and Publishing", summary: "The issue has been identified and a fix is being implemented." })
  expect(readStatus("Login issues", "<p><small>Oct 14</small><br><strong>Resolved</strong> - This incident has been resolved. </p><p><strong>Monitoring</strong> - A fix…</p>"))
    .toMatchObject({ phase: "resolved", status: "Resolved" })
  expect(readStatus("AMD (Ahmedabad) on 2026-11-02", "<p><small>Oct 8</small><br><strong>Scheduled</strong> - We will be performing scheduled maintenance.</p>"))
    .toMatchObject({ phase: "scheduled" })
  expect(readStatus("ChatGPT conversion failures", "<b>Status: Monitoring</b><br/><br/>We have applied the mitigation and are monitoring the recovery.<br/><br/><b>Affected components</b><ul><li>Conversations (Degraded performance)</li></ul>"))
    .toEqual({ phase: "monitoring", status: "Monitoring", title: "ChatGPT conversion failures", summary: "We have applied the mitigation and are monitoring the recovery." })
  expect(readStatus("RESOLVED: **Summary:** Mitigating elevated error rate with Studio web. **Description:** Work is underway.",
    "<p> Incident began at <strong>2026-09-25 15:47</strong> and ended at <strong>2026-09-25 16:40</strong></p><div><p><strong>Summary:</strong></p><p>Mitigated elevated error rate with Studio web.</p><p><strong>Description:</strong></p><p>The issue has been resolved for all affected users.</p></div>"))
    .toEqual({ phase: "resolved", status: "Resolved", title: "Mitigated elevated error rate with Studio web.", summary: "The issue has been resolved for all affected users." })
  expect(readStatus("Gmail delays", "<p> Incident began at <strong>2026-10-21 08:00</strong></p>")).toMatchObject({ phase: "active", status: "Ongoing" })
  // Statuspage's own "Update" label means still in progress.
  expect(readStatus("Webhooks delayed", "<p><strong>Update</strong> - We are still working on it.</p>")).toMatchObject({ phase: "active", status: "Ongoing" })
  // Slack and AWS: prose posts, judged by their wording.
  expect(readStatus("Incident: Slow behaviour in Slack", "This issue is now resolved for all users.")).toMatchObject({ phase: "resolved", status: "Resolved", title: "Slow behaviour in Slack" })
  expect(readStatus("Service disruption: Increased Error Rates", "We are providing an update on the ongoing disruption.")).toMatchObject({ phase: "monitoring", status: "Ongoing" })
})

test("release feeds are news even when their markup resembles a status page", () => {
  // OpenRouter and OpenAI news bodies contain "<strong>…</strong> - " runs.
  expect(interpret(item("Flint (free)", "<p><strong>Context</strong> - 128k tokens</p>"), "release")).toEqual({ phase: "news", title: "Flint (free)", summary: "Context - 128k tokens" })
  expect(interpret(item("v2.1.2", "<p>release: v2.1.2</p>"), "release")).toEqual({ phase: "news", title: "v2.1.2", summary: "release: v2.1.2" })
})

test("the timeline pins in-progress items, applies the window, and lists quiet status feeds as operational", () => {
  const now = Date.parse("2026-10-22T12:00:00Z")
  const hours = (count: number) => now - count * 60 * 60_000
  const incident = (title: string, status: string, time: number) => ({ id: title, title, published: time, content: `<p><strong>${status}</strong> - ${title} details</p>` })
  const ok = (items: object[]): FetchResult => ({ status: "ok", fetchedAt: now, feed: { items: items as never } })
  const subscriptions = ["npm", "gh", "claude", "azure", "blog", "news", "down", "slow"].map((name, index) => ({
    url: `https://${name}.test/rss`, kind: name === "blog" || name === "news" ? "release" as const : "status" as const, createdAt: index,
  }))
  const results = new Map<string, FetchResult>([
    ["https://npm.test/rss", ok([incident("Publishing degraded", "Identified", hours(30)), incident("Old outage", "Resolved", hours(2))])],
    // Statuspage dates scheduled maintenance at its future start.
    ["https://gh.test/rss", ok([incident("Maintenance later", "Scheduled", hours(-48)), incident("Maintenance soon", "Scheduled", hours(-3)),
      incident("Webhooks delayed", "Resolved", hours(7)), incident("Ancient", "Resolved", hours(100))])],
    ["https://claude.test/rss", ok([incident("Errors", "Resolved", hours(60))])],
    // Azure's feed is empty while everything is healthy.
    ["https://azure.test/rss", ok([])],
    ["https://blog.test/rss", ok([{ id: "post", title: "New release", published: hours(1) }])],
    // A busy release feed contributes only its newest three posts.
    ["https://news.test/rss", ok([5, 4, 3, 2, 1].map((n) => ({ id: `n${n}`, title: `Story ${n}`, published: hours(n + 0.5) })))],
    ["https://down.test/rss", { status: "error", error: "HTTP 503" }],
    ["https://slow.test/rss", { status: "loading" }],
  ])
  const view = timeline(subscriptions, [], results, { windowHours: 24, resolved: "both", sidebarReleases: false }, "feed", { now })
  // The 30h-old incident is outside the 24h window but still in progress.
  expect(view.current.map((entry) => [entry.source, entry.status, entry.title])).toEqual([["npm.test", "Identified", "Publishing degraded"]])
  expect(view.recent.map((entry) => entry.title)).toEqual(["New release", "Story 1", "Old outage", "Story 2", "Story 3", "Webhooks delayed"])
  expect(view.upcoming.map((entry) => entry.title)).toEqual(["Maintenance soon"])
  expect(view.operational).toEqual(["azure.test", "claude.test", "gh.test"])
  expect(view.unreachable).toEqual([{ source: "down.test", error: "HTTP 503", kind: "status" }])
  expect(view.pending).toBe(1)

  const quiet = timeline(subscriptions, [], results, { windowHours: 6, resolved: "none", sidebarReleases: false }, "feed", { now })
  expect(quiet.current).toHaveLength(1)
  expect(quiet.recent.map((entry) => entry.title)).toEqual(["New release", "Story 1", "Story 2", "Story 3"])

  // One feed shows its history: past the window, past the release cap, and resolved items too.
  const github = timeline(subscriptions, [], results, { windowHours: 6, resolved: "none", sidebarReleases: false }, "feed", { now, feed: "https://gh.test/rss" })
  expect(github.recent.map((entry) => entry.title)).toEqual(["Webhooks delayed", "Ancient"])
  expect(github.upcoming.map((entry) => entry.title)).toEqual(["Maintenance soon", "Maintenance later"])
  expect(github.operational).toEqual(["gh.test"])
  const news = timeline(subscriptions, [], results, { windowHours: 6, resolved: "none", sidebarReleases: false }, "feed", { now, feed: "https://news.test/rss" })
  expect(news.recent.map((entry) => entry.title)).toEqual(["Story 1", "Story 2", "Story 3", "Story 4", "Story 5"])
})

test("one feed's history keeps its newest twenty items", () => {
  const now = Date.parse("2026-10-22T12:00:00Z")
  const items = Array.from({ length: 30 }, (_, index) => ({ id: `${index}`, title: `Post ${index}`, published: now - (index + 1) * 24 * 60 * 60_000 }))
  const view = timeline([{ url: "https://blog.test/rss", kind: "release", createdAt: 0 }], [], new Map([["https://blog.test/rss", { status: "ok", fetchedAt: now, feed: { items } }]]),
    { windowHours: 12, resolved: "none", sidebarReleases: false }, "feed", { now, feed: "https://blog.test/rss" })
  expect(view.recent).toHaveLength(20)
  expect(view.recent[0]!.title).toBe("Post 0")
  expect(view.recent.at(-1)!.title).toBe("Post 19")
})

test("resolved items appear only on the surfaces the setting names", () => {
  const now = Date.parse("2026-10-22T12:00:00Z")
  const results = new Map<string, FetchResult>([["https://npm.test/rss", { status: "ok", fetchedAt: now, feed: { items: [
    { id: "1", title: "Fixed", published: now - 60_000, content: "<p><strong>Resolved</strong> - Done.</p>" },
    { id: "2", title: "Broken", published: now - 60_000, content: "<p><strong>Investigating</strong> - Looking.</p>" },
  ] } }]])
  const titles = (resolved: SurfaceScope, surface: Surface) => {
    const view = timeline([{ url: "https://npm.test/rss", kind: "status", createdAt: 0 }], [], results, { windowHours: 24, resolved, sidebarReleases: true }, surface, { now })
    return [...view.current, ...view.recent].map((entry) => entry.title)
  }
  expect(titles("both", "sidebar")).toEqual(["Broken", "Fixed"])
  expect(titles("sidebar", "sidebar")).toEqual(["Broken", "Fixed"])
  expect(titles("sidebar", "feed")).toEqual(["Broken"])
  expect(titles("feed", "sidebar")).toEqual(["Broken"])
  expect(titles("feed", "feed")).toEqual(["Broken", "Fixed"])
  expect(titles("none", "feed")).toEqual(["Broken"])
})

test("release feeds always appear in /feed and in the sidebar only when asked; status pages always do", () => {
  const now = Date.parse("2026-10-22T12:00:00Z")
  const subscriptions = [
    { url: "https://npm.test/rss", kind: "status" as const, createdAt: 0 },
    { url: "https://bun.test/releases", kind: "release" as const, createdAt: 1 },
    { url: "https://down.test/blog", kind: "release" as const, createdAt: 2 },
  ]
  const results = new Map<string, FetchResult>([
    ["https://npm.test/rss", { status: "ok", fetchedAt: now, feed: { items: [{ id: "1", title: "Broken", published: now - 60_000, content: "<p><strong>Investigating</strong> - Looking.</p>" }] } }],
    ["https://bun.test/releases", { status: "ok", fetchedAt: now, feed: { items: [{ id: "2", title: "Bun v2", published: now - 60_000 }] } }],
    ["https://down.test/blog", { status: "error", error: "HTTP 503" }],
  ])
  const view = (sidebarReleases: boolean, surface: Surface) => timeline(subscriptions, [], results, { windowHours: 24, resolved: "none", sidebarReleases }, surface, { now })
  const titles = (sidebarReleases: boolean, surface: Surface) => { const v = view(sidebarReleases, surface); return [...v.current, ...v.recent].map((entry) => entry.title) }
  // The default keeps releases out of the sidebar.
  expect(titles(false, "sidebar")).toEqual(["Broken"])
  expect(titles(false, "feed")).toEqual(["Broken", "Bun v2"])
  expect(titles(true, "sidebar")).toEqual(["Broken", "Bun v2"])
  // A release feed kept out of the sidebar keeps its failure out too.
  expect(view(false, "sidebar").unreachable).toEqual([])
  expect(view(true, "sidebar").unreachable).toEqual([{ source: "down.test", error: "HTTP 503", kind: "release" }])
  expect(view(false, "feed").unreachable).toEqual([{ source: "down.test", error: "HTTP 503", kind: "release" }])
})

test("the editor's box filters feeds under kind headings and offers to add a new URL as either kind", () => {
  const rows = managerRows([], presets, new Map())
  const label = (row: EditRow) => row.kind === "heading" || row.kind === "feed" ? row.title : `add ${row.feedKind}`
  expect(editRows(rows, "google", candidateURL("google")).map(label)).toEqual(["STATUS PAGES", "Google Workspace", "Google Cloud"])
  expect(editRows(rows, "openai", candidateURL("openai")).map(label)).toEqual(["STATUS PAGES", "OpenAI", "RELEASES", "OpenAI news"])
  expect(editRows(rows, "bun.sh/rss.xml", candidateURL("bun.sh/rss.xml")).slice(0, 2)).toEqual([
    { kind: "add", url: "https://bun.sh/rss.xml", feedKind: "status" },
    { kind: "add", url: "https://bun.sh/rss.xml", feedKind: "release" },
  ])
  // An already-listed URL is just a match, not another add.
  expect(editRows(rows, presets[0]!.url, candidateURL(presets[0]!.url)).map((row) => row.kind)).toEqual(["heading", "feed"])
  expect(candidateURL("npm")).toBeUndefined()
  expect(candidateURL("github status")).toBeUndefined()
  expect(candidateURL("http://localhost:8080/feed")).toBe("http://localhost:8080/feed")
})

const entry = (title: string, extra: Partial<TimelineEntry> = {}): TimelineEntry => ({ key: title, url: "https://x.test", kind: "status", source: "npm", title, phase: "active", time: 0, ...extra })

test("search requires every word somewhere in the product, status, title, or text", () => {
  const incident = entry("Degraded Package Install", { status: "Identified", summary: "A fix is being implemented." })
  expect(matches(incident, "")).toBe(true)
  expect(matches(incident, "NPM fix")).toBe(true)
  expect(matches(incident, "identified install")).toBe(true)
  expect(matches(incident, "npm outage")).toBe(false)
})

test("the sidebar keeps the configured number of items and two scheduled items, counting the rest", () => {
  const many = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => entry(`${prefix}${index}`))
  const view = { current: many("now", 2), recent: many("recent", 5), upcoming: many("soon", 4), operational: [], unreachable: [], pending: 0 }
  const layout = sidebarLayout(view, 5)
  expect(layout.entries.map((item) => item.title)).toEqual(["now0", "now1", "recent0", "recent1", "recent2"])
  expect(layout.hiddenEntries).toBe(2)
  expect(layout.upcoming.map((item) => item.title)).toEqual(["soon0", "soon1"])
  expect(layout.hiddenUpcoming).toBe(2)
  // In-progress items take the budget first; scheduled items do not count against it.
  expect(sidebarLayout(view, 3)).toMatchObject({ entries: [{ title: "now0" }, { title: "now1" }, { title: "recent0" }], hiddenEntries: 4, hiddenUpcoming: 2 })
  expect(sidebarLayout(view, 10)).toMatchObject({ hiddenEntries: 0, hiddenUpcoming: 2 })
})

test("links open with the platform's launcher, and only http(s) links open at all", () => {
  expect(launchers("https://a.test", "darwin")).toEqual([["open", "https://a.test"]])
  expect(launchers("https://a.test", "linux", {}, "6.8.0-generic")).toEqual([["xdg-open", "https://a.test"]])
  const wsl = launchers("https://a.test/?q='x'", "linux", { WSL_DISTRO_NAME: "Ubuntu" }, "6.18-microsoft-standard-WSL2")
  expect(wsl.map(([name]) => name)).toEqual(["wslview", "xdg-open", "powershell.exe"])
  expect(wsl[2]!.at(-1)).toBe("Start-Process 'https://a.test/?q=''x'''")
  expect(() => openURL("file:///etc/passwd", () => "/bin/true")).toThrow("Refusing to open")
  expect(() => openURL("https://a.test", () => null)).toThrow("No browser launcher found")
})

test("settings persist across reopening the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opcode-feed-"))
  afterAll(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "feed.sqlite")
  const first = new FeedsDatabase(path)
  // A fresh install looks back 12 hours, hides resolved incidents, and refreshes every 10 minutes.
  expect(first.settings()).toEqual({ windowHours: 12, resolved: "none", sidebarReleases: false, sidebarItems: 5, refreshMinutes: 10 })
  await createRoot(async (dispose) => {
    const feeds = new FeedsController(first, async () => rss)
    feeds.updateSettings({ windowHours: 72 })
    feeds.updateSettings({ resolved: "sidebar" })
    feeds.updateSettings({ sidebarReleases: true })
    feeds.updateSettings({ sidebarItems: 10 })
    feeds.updateSettings({ refreshMinutes: 30 })
    dispose()
  })
  first.close()
  const second = new FeedsDatabase(path)
  expect(second.settings()).toEqual({ windowHours: 72, resolved: "sidebar", sidebarReleases: true, sidebarItems: 10, refreshMinutes: 30 })
  second.close()
})

test("0.1.x databases rename release subscriptions and gain the releases setting, keeping saved choices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opcode-feed-"))
  afterAll(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "feed.sqlite")
  const legacy = new Database(path)
  legacy.exec(`
    CREATE TABLE subscriptions (url TEXT PRIMARY KEY, title TEXT, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), window_hours INTEGER NOT NULL, resolved TEXT NOT NULL);
    INSERT INTO settings (id, window_hours, resolved) VALUES (1, 6, 'both');
    INSERT INTO subscriptions VALUES ('https://bun.test/releases', NULL, 'updates', 1);
  `)
  legacy.close()
  const migrated = new FeedsDatabase(path)
  expect(migrated.settings()).toEqual({ windowHours: 6, resolved: "both", sidebarReleases: false, sidebarItems: 5, refreshMinutes: 10 })
  expect(migrated.list().map((subscription) => subscription.url)).toEqual(["https://bun.test/releases"])
  migrated.saveSettings({ windowHours: 6, resolved: "both", sidebarReleases: true, sidebarItems: 5, refreshMinutes: 10 })
  migrated.close()
  const reopened = new FeedsDatabase(path)
  expect(reopened.settings().sidebarReleases).toBe(true)
  reopened.close()
})

test("0.2.0 and 0.3.0 databases keep releases in the sidebar when their saved choice included it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opcode-feed-"))
  afterAll(() => rm(directory, { recursive: true, force: true }))
  // 0.2.0 stored the choice as `updates`; 0.3.0 as `releases`, keeping a stale `updates` from 0.2.0.
  const open = (name: string, columns: string, values: string) => {
    const path = join(directory, `${name}.sqlite`)
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE subscriptions (url TEXT PRIMARY KEY, title TEXT, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), window_hours INTEGER NOT NULL, resolved TEXT NOT NULL, ${columns});
      INSERT INTO settings VALUES (1, 24, 'none', ${values});
      INSERT INTO subscriptions VALUES ('https://bun.test/releases', NULL, 'updates', 1);
    `)
    legacy.close()
    return { path, database: new FeedsDatabase(path) }
  }
  const scopes: [SurfaceScope, boolean][] = [["both", true], ["sidebar", true], ["feed", false], ["none", false]]
  for (const [scope, sidebarReleases] of scopes) {
    const v2 = open(`v2-${scope}`, "updates TEXT NOT NULL DEFAULT 'feed'", `'${scope}'`).database
    expect(v2.settings()).toEqual({ windowHours: 24, resolved: "none", sidebarReleases, sidebarItems: 5, refreshMinutes: 10 })
    expect(v2.list()).toMatchObject([{ url: "https://bun.test/releases", kind: "release" }])
    v2.close()
    const v3 = open(`v3-${scope}`, "updates TEXT NOT NULL DEFAULT 'feed', releases TEXT NOT NULL DEFAULT 'feed'", `'${sidebarReleases ? "none" : "both"}', '${scope}'`).database
    expect(v3.settings().sidebarReleases).toBe(sidebarReleases)
    v3.close()
  }
  // Saving later, with the old columns still present, works and keeps the new value.
  const { path, database } = open("saved", "updates TEXT NOT NULL DEFAULT 'feed', releases TEXT NOT NULL DEFAULT 'feed'", "'feed', 'both'")
  database.saveSettings({ windowHours: 24, resolved: "none", sidebarReleases: false, sidebarItems: 5, refreshMinutes: 10 })
  database.close()
  const reopened = new FeedsDatabase(path)
  expect(reopened.settings().sidebarReleases).toBe(false)
  reopened.close()
})

test("0.3.0 databases gain the sidebar length and refresh interval at their defaults, which unknown stored values fall back to", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opcode-feed-"))
  afterAll(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "feed.sqlite")
  const legacy = new Database(path)
  legacy.exec(`
    CREATE TABLE subscriptions (url TEXT PRIMARY KEY, title TEXT, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), window_hours INTEGER NOT NULL, resolved TEXT NOT NULL, releases TEXT NOT NULL DEFAULT 'feed');
    INSERT INTO settings (id, window_hours, resolved, releases) VALUES (1, 24, 'both', 'sidebar');
  `)
  legacy.close()
  const migrated = new FeedsDatabase(path)
  expect(migrated.settings()).toEqual({ windowHours: 24, resolved: "both", sidebarReleases: true, sidebarItems: 5, refreshMinutes: 10 })
  migrated.close()
  // Values this version does not offer, such as ones written by another version.
  const edited = new Database(path)
  edited.exec("UPDATE settings SET sidebar_items = 7, refresh_minutes = 7")
  edited.close()
  const reopened = new FeedsDatabase(path)
  expect(reopened.settings()).toEqual({ windowHours: 24, resolved: "both", sidebarReleases: true, sidebarItems: 5, refreshMinutes: 10 })
  reopened.close()
})

test("ages are compact", () => {
  const now = Date.parse("2026-10-21T12:00:00Z")
  const hours = (count: number) => now - count * 60 * 60_000
  expect(age(now - 5 * 60_000, now)).toBe("5m")
  expect(age(hours(23.9), now)).toBe("23h")
  expect(age(hours(29), now)).toBe("1d 5h")
  expect(age(hours(48), now)).toBe("2d")
  expect(age(hours(9 * 24 + 3), now)).toBe("9d 3h")
  // Upcoming items count the other way, with the same format.
  expect(age(now, hours(-30))).toBe("1d 6h")
  expect(age(undefined, now)).toBe("")
})

test("the refresh line counts down to the second", () => {
  const now = Date.parse("2026-10-21T12:00:00Z")
  expect(refreshStatus(true, now + 5 * 60_000, now)).toBe("Refreshing…")
  expect(refreshStatus(false, now + 4 * 60_000 + 5_500, now)).toBe("Next refresh in 4m 06s")
  expect(refreshStatus(false, now + 60 * 60_000, now)).toBe("Next refresh in 60m 00s")
  expect(refreshStatus(false, now + 30_000, now)).toBe("Next refresh in 30s")
  expect(refreshStatus(false, now - 1_000, now)).toBe("Next refresh in 0s")
  expect(refreshStatus(false, undefined, now)).toBeUndefined()
})

test("subscriptions persist, fetch on subscribe, and late results after unsubscribe are dropped", async () => {
  const database = new FeedsDatabase(":memory:")
  const pending = new Map<string, (xml: string) => void>()
  const fetcher: Fetcher = (url) => new Promise((resolve) => pending.set(url, resolve))
  await createRoot(async (dispose) => {
    const feeds = new FeedsController(database, fetcher)
    expect(feeds.subscribe("https://status.npmjs.org/history.rss", "status")).toBe(true)
    expect(feeds.subscribe("https://status.npmjs.org/history.rss", "status")).toBe(false)
    expect(feeds.results().get("https://status.npmjs.org/history.rss")?.status).toBe("loading")
    pending.get("https://status.npmjs.org/history.rss")!(rss)
    await Bun.sleep(0)
    expect(feeds.results().get("https://status.npmjs.org/history.rss")).toMatchObject({ status: "ok", feed: { title: "npm Status - Incident History" } })
    expect(database.list()).toMatchObject([{ url: "https://status.npmjs.org/history.rss", title: "npm Status - Incident History", kind: "status" }])

    feeds.subscribe("https://example.com/slow.xml", "release")
    feeds.unsubscribe("https://example.com/slow.xml")
    pending.get("https://example.com/slow.xml")!(atom)
    await Bun.sleep(0)
    expect(feeds.results().has("https://example.com/slow.xml")).toBe(false)
    expect(database.list().map((subscription) => subscription.url)).toEqual(["https://status.npmjs.org/history.rss"])
    feeds.dispose()
    dispose()
  })
  database.close()
})

test("a failed refresh keeps the previous items alongside the error", async () => {
  const database = new FeedsDatabase(":memory:")
  let fail = false
  const fetcher: Fetcher = async () => { if (fail) throw new Error("HTTP 503"); return rss }
  await createRoot(async (dispose) => {
    const feeds = new FeedsController(database, fetcher, { retryDelays: [] })
    feeds.subscribe("https://status.npmjs.org/history.rss", "status")
    await Bun.sleep(0)
    fail = true
    await feeds.refreshAll()
    expect(feeds.results().get("https://status.npmjs.org/history.rss")).toMatchObject({ status: "error", error: "HTTP 503", feed: { items: [{ title: "Elevated errors & latency" }, {}] } })
    feeds.dispose()
    dispose()
  })
  database.close()
})

/** Timers that run only when a test fires them. */
function fakeTimers() {
  const pending = new Set<{ run: () => void; ms: number }>()
  const timer: SetTimer = (run, ms) => { const entry = { run, ms }; pending.add(entry); return () => { pending.delete(entry) } }
  const fire = async (ms: number) => {
    for (const entry of [...pending]) if (entry.ms === ms) { pending.delete(entry); entry.run() }
    await Bun.sleep(0)
  }
  return { timer, fire }
}

const npm = "https://status.npmjs.org/history.rss"

test("a failed fetch is retried within seconds before it shows as unreachable, then again on the refresh schedule", async () => {
  const database = new FeedsDatabase(":memory:")
  database.subscribe(npm, "status")
  const timers = fakeTimers()
  let calls = 0
  const fetcher: Fetcher = async () => { if (++calls <= 3) throw new Error("HTTP 503"); return rss }
  await createRoot(async (dispose) => {
    const feeds = new FeedsController(database, fetcher, { timer: timers.timer })
    feeds.start()
    await Bun.sleep(0)
    expect(feeds.results().get(npm)?.status).toBe("loading")
    await timers.fire(2_000)
    expect(feeds.results().get(npm)?.status).toBe("loading")
    expect(feeds.timeline("sidebar").unreachable).toEqual([])
    await timers.fire(5_000)
    expect(feeds.results().get(npm)).toMatchObject({ status: "error", error: "HTTP 503" })
    expect(calls).toBe(3)
    await timers.fire(10 * 60_000)
    expect(feeds.results().get(npm)?.status).toBe("ok")
    feeds.dispose()
    dispose()
  })
  database.close()
})

test("refreshes follow the interval setting; changing it, refreshing by hand, or waking late restarts the countdown", async () => {
  const database = new FeedsDatabase(":memory:")
  database.subscribe(npm, "status")
  const timers = fakeTimers()
  let calls = 0
  const fetcher: Fetcher = async () => { calls++; return rss }
  await createRoot(async (dispose) => {
    const feeds = new FeedsController(database, fetcher, { timer: timers.timer })
    const minutesLeft = () => Math.round((feeds.nextRefresh()! - Date.now()) / 60_000)
    feeds.start()
    await Bun.sleep(0)
    expect(calls).toBe(1)
    expect(minutesLeft()).toBe(10)
    feeds.updateSettings({ refreshMinutes: 5 })
    expect(minutesLeft()).toBe(5)
    // The old schedule is gone.
    await timers.fire(10 * 60_000)
    expect(calls).toBe(1)
    await timers.fire(5 * 60_000)
    expect(calls).toBe(2)
    // A refresh by hand replaces the pending automatic one rather than adding another.
    await feeds.refreshAll()
    await timers.fire(5 * 60_000)
    expect(calls).toBe(4)
    // Timers run late across sleep; a clock tick past the deadline refreshes.
    feeds.tick(feeds.nextRefresh()! - 1)
    await Bun.sleep(0)
    expect(calls).toBe(4)
    feeds.tick(feeds.nextRefresh()! + 1)
    await Bun.sleep(0)
    expect(calls).toBe(5)
    feeds.dispose()
    dispose()
  })
  database.close()
})

test("a newer fetch of a feed wins over an older one that settles later", async () => {
  const database = new FeedsDatabase(":memory:")
  const calls: { resolve(xml: string): void; reject(error: Error): void }[] = []
  const fetcher: Fetcher = () => new Promise((resolve, reject) => calls.push({ resolve, reject }))
  await createRoot(async (dispose) => {
    const feeds = new FeedsController(database, fetcher, { retryDelays: [], timer: fakeTimers().timer })
    feeds.subscribe(npm, "status")
    void feeds.refreshAll()
    calls[1]!.resolve(rss)
    await Bun.sleep(0)
    calls[0]!.reject(new Error("The operation timed out."))
    await Bun.sleep(0)
    expect(feeds.results().get(npm)?.status).toBe("ok")
    feeds.dispose()
    dispose()
  })
  database.close()
})
