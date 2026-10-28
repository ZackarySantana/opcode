/** @jsxImportSource @opentui/solid */

import { ItemList, Picker, SettingsTab, TabbedDialog, TabFrame, useTab, type Item, type SettingRow } from "@opcode/tabs"
import { age, relative } from "@opcode/tabs/format"
import { openLink } from "@opcode/tabs/open"
import { CenterEmpty, usePalette } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { FeedsClient } from "./client"
import { FEED_HISTORY, kindOf, managerRows, matches, PLUGIN_ID, refreshChoices, scopeChoices, sidebarItemChoices, windowChoices, windowLabel, windowShort, type Settings, type SurfaceScope, type TimelineEntry } from "./model"
import { presets, type FeedKind } from "./presets"
import { clockTime, feedLine, phaseStyle } from "./style"
import { Subscribe } from "./subscribe"

export function FeedDialog(props: { feeds: FeedsClient }) {
  return (
    <TabbedDialog prefix={PLUGIN_ID} refreshing={props.feeds.refreshing()} refresh={() => props.feeds.refresh()} tabs={[
      { label: "Status", placeholder: "search status pages", render: () => <Browser feeds={props.feeds} kind="status" /> },
      { label: "Upcoming", placeholder: "search scheduled maintenance", render: () => <Browser feeds={props.feeds} kind="upcoming" /> },
      { label: "Releases", placeholder: "search releases", render: () => <Browser feeds={props.feeds} kind="releases" /> },
      { label: "Subscribe", placeholder: "search feeds or paste a URL to subscribe", render: () => <Subscribe feeds={props.feeds} /> },
      { label: "Settings", placeholder: "search settings",
        render: () => <SettingsTab rows={settingRows} settings={props.feeds.settings()} update={(change) => props.feeds.updateSettings(change)} /> },
    ]} />
  )
}

/** Status, Upcoming, and Releases: enter opens the focused item's link; f narrows to one feed of the tab's kind. */
function Browser(props: { feeds: FeedsClient; kind: "status" | "upcoming" | "releases" }) {
  const api = usePlugin()
  const tab = useTab()
  const palette = usePalette()
  const [scope, setScope] = createSignal<string>()
  const [picking, setPicking] = createSignal(false)
  const timeline = createMemo(() => props.feeds.timeline("feed", scope()))
  const settings = () => props.feeds.settings()
  const filter = (entries: readonly TimelineEntry[]) => entries.filter((entry) => matches(entry, tab.query()))
  const window = () => windowLabel(settings().windowHours).toUpperCase()
  const feedKind: FeedKind = props.kind === "releases" ? "release" : "status"
  const ofKind = <T extends { kind: FeedKind }>(entries: readonly T[]) => entries.filter((entry) => entry.kind === feedKind)
  const recentTitle = () => scope() ? `LATEST ${FEED_HISTORY}` : `LAST ${window()}`
  const groups = createMemo(() => props.kind === "upcoming"
    ? [{ title: scope() ? "SCHEDULED" : `NEXT ${window()}`, entries: filter(timeline().upcoming) }]
    : props.kind === "releases"
      ? [{ title: recentTitle(), entries: filter(ofKind(timeline().recent)) }]
      : [
        { title: "IN PROGRESS", entries: filter(timeline().current) },
        { title: recentTitle(), entries: filter(ofKind(timeline().recent)) },
      ])
  const item = (entry: TimelineEntry): Item => ({
    key: entry.key, mark: phaseStyle(entry.phase, palette), head: entry.status ?? entry.source, detail: entry.status ? entry.source : undefined,
    time: `${relative(entry.time, props.feeds.now())} · ${clockTime(entry.time)}`, title: entry.title, summary: entry.summary, link: entry.link,
  })
  const subscribed = () => props.feeds.subscriptions().some((subscription) => kindOf(subscription, presets) === feedKind)
  const feeds = createMemo(() => managerRows(props.feeds.subscriptions(), presets, props.feeds.results())
    .filter((row) => row.subscribed && row.kind === feedKind)
    .map((row) => ({ key: row.url, label: row.title, ...feedLine(row.result, row.kind, props.feeds.now(), palette) })))
  const focus = createSignal<string>()
  // The picker opens on the outlined item's feed, so f then enter shows more of it.
  const [initial, setInitial] = createSignal<string>()
  const pick = () => {
    const entries = groups().flatMap((group) => group.entries)
    setInitial((entries.find((entry) => entry.key === focus[0]()) ?? entries[0])?.url ?? scope())
    setPicking(true)
  }
  const hints = () => [
    ...tab.navigation,
    { key: "enter", label: "open link", command: tab.command("activate") },
    { key: "f", label: scope() ? "change feed" : "feed", command: tab.command("pick") },
    { key: "/", label: "search", command: tab.command("search") },
    { key: "r", label: "refresh", command: tab.command("refresh") },
  ]
  return (
    <Show when={!picking()} fallback={
      <Picker options={feeds()} all="All feeds" noun="feeds" action="show feed" initial={initial()}
        pick={(feed) => { setScope(feed); setPicking(false) }} close={() => setPicking(false)} />
    }>
      <Show when={subscribed()} fallback={
        <TabFrame hints={hints()}>
          <Show when={props.feeds.error()} fallback={
            <CenterEmpty title={feedKind === "status" ? "No status pages yet" : "No release feeds yet"} description="Subscribe to one in the Subscribe tab." />
          }>{(error) => <CenterEmpty title="Couldn't load your feeds" description={error()} />}</Show>
        </TabFrame>
      }>
        <ItemList hints={hints()} focus={focus} open={(entry) => openLink(api, "Feed", entry.link)}
          groups={groups().map((group) => ({ title: group.title, items: group.entries.map(item) }))}
          empty={tab.query() ? "No matching items." : timeline().pending ? "Loading…" : "Nothing in this window."}
          handlers={{
            pick,
            back: () => scope() ? { label: "all feeds", run: () => setScope(undefined) } : undefined,
            prefix: () => scope() && props.feeds.title(scope()!),
          }}
          header={<>
            <Show when={props.feeds.error()}>{(error) => <text minWidth={0} wrapMode="word" fg={palette.error}>! {error()}</text>}</Show>
            <Show when={props.kind !== "upcoming" && !tab.query()}>
              <Show when={props.kind === "status" && timeline().operational.length}>
                <text minWidth={0} wrapMode="word" fg={palette.muted}>✓ Operational: {timeline().operational.join(" · ")}</text>
              </Show>
              <For each={ofKind(timeline().unreachable)}>{(failure) => (
                <text minWidth={0} wrapMode="word" fg={palette.error}>! {failure.source} unreachable: {failure.error}</text>
              )}</For>
            </Show>
          </>} />
      </Show>
    </Show>
  )
}

const scopeLabels: Record<SurfaceScope, string> = { both: "Both", sidebar: "Sidebar", feed: "/feed", none: "None" }

const settingRows = [
  {
    id: "window", label: "Time window",
    description: "How far back Status and Releases look, and how far ahead Upcoming looks. In-progress items always show.",
    choices: windowChoices.map((hours) => ({ value: hours as number, label: windowShort(hours) })),
    current: (settings) => settings.windowHours,
    update: (windowHours) => ({ windowHours }),
  } satisfies SettingRow<Settings, number>,
  {
    id: "resolved", label: "Show resolved",
    description: "Where resolved and completed incidents appear.",
    choices: scopeChoices.map((scope) => ({ value: scope, label: scopeLabels[scope] })),
    current: (settings) => settings.resolved,
    update: (resolved) => ({ resolved }),
  } satisfies SettingRow<Settings, SurfaceScope>,
  {
    id: "releases", label: "Sidebar releases",
    description: "Whether posts from release feeds also appear in the sidebar. The Releases tab always has them.",
    choices: [{ value: false, label: "No" }, { value: true, label: "Yes" }],
    current: (settings) => settings.sidebarReleases,
    update: (sidebarReleases) => ({ sidebarReleases }),
  } satisfies SettingRow<Settings, boolean>,
  {
    id: "sidebar", label: "Sidebar items",
    description: "How many items the sidebar lists, in-progress first, before pointing to /feed. Up to two scheduled items follow them.",
    choices: sidebarItemChoices.map((count) => ({ value: count as number, label: `${count}` })),
    current: (settings) => settings.sidebarItems,
    update: (sidebarItems) => ({ sidebarItems }),
  } satisfies SettingRow<Settings, number>,
  {
    id: "refresh", label: "Refresh every",
    description: "How often every feed is fetched again, unreachable ones included. A failed fetch is first retried twice within seconds; r refreshes now.",
    choices: refreshChoices.map((minutes) => ({ value: minutes, label: age(0, minutes * 60_000) })),
    current: (settings) => settings.refreshMinutes,
    update: (refreshMinutes) => ({ refreshMinutes }),
  } satisfies SettingRow<Settings, number>,
] as SettingRow<Settings>[]
