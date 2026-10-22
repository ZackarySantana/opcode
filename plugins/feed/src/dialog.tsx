/** @jsxImportSource @opentui/solid */

import { errorMessage } from "@opcode/core"
import { Card, CenterEmpty, KeyHints, usePalette } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import type { FeedsController } from "./host"
import { FEED_HISTORY, kindOf, matches, matchesText, relative, scopeChoices, sidebarItemChoices, windowChoices, windowLabel, windowShort, type SurfaceScope, type Settings as FeedSettings, type TimelineEntry } from "./model"
import { openURL } from "./open"
import { TabFrame } from "./frame"
import { FeedPicker } from "./picker"
import { presets, type FeedKind } from "./presets"
import { clockTime, phaseStyle } from "./style"
import { Subscribe } from "./subscribe"
import { navigationHints, useFocus, type TabHandlers, type TabProps } from "./tab"

const tabs = [
  { id: "status", label: "Status", placeholder: "search status pages" },
  { id: "upcoming", label: "Upcoming", placeholder: "search scheduled maintenance" },
  { id: "releases", label: "Releases", placeholder: "search releases" },
  { id: "subscribe", label: "Subscribe", placeholder: "search feeds or paste a URL to subscribe" },
  { id: "settings", label: "Settings", placeholder: "search settings" },
] as const

export function FeedDialog(props: { feeds: FeedsController }) {
  const api = usePlugin()
  const palette = usePalette()
  const dimensions = useTerminalDimensions()
  const [tab, setTab] = createSignal(0)
  const [typing, setTyping] = createSignal(false)
  const [query, setQuery] = createSignal("")
  // Status, Upcoming, and Releases can narrow to one feed, chosen in the picker (f).
  const [scope, setScope] = createSignal<string>()
  const [picking, setPicking] = createSignal(false)
  const [width, setWidth] = createSignal(80)
  const bodyHeight = () => Math.max(6, Math.min(32, dimensions().height - 11))
  const loading = () => [...props.feeds.results().values()].some((result) => result.status === "loading")
  let handlers: TabHandlers | undefined
  const reset = () => { setTyping(false); setQuery("") }
  const switchTab = (by: number) => { reset(); setPicking(false); setScope(undefined); setTab((value) => (value + by + tabs.length) % tabs.length) }
  const idle = () => !typing()
  const current = () => tabs[tab()]!.id

  useDialogCommands(api, () => [
    // Each Escape undoes one thing: typing, the picker, the search, the feed, then the dialog.
    { id: "opcode-feed.close", bind: "escape", run: () => {
      if (typing()) setTyping(false)
      else if (picking()) { setPicking(false); setQuery("") }
      else if (query()) setQuery("")
      else if (scope()) setScope(undefined)
      else api.ui.dialog.clear()
    } },
    { id: "opcode-feed.next", bind: "tab", run: () => switchTab(1) },
    { id: "opcode-feed.previous", bind: "shift+tab", run: () => switchTab(-1) },
    // Up/down stay live while typing, so results can be browsed without leaving the box.
    { id: "opcode-feed.down", bind: "down", run: () => handlers?.move(1) },
    { id: "opcode-feed.up", bind: "up", run: () => handlers?.move(-1) },
    { id: "opcode-feed.down.vi", bind: "j", enabled: idle, run: () => handlers?.move(1) },
    { id: "opcode-feed.up.vi", bind: "k", enabled: idle, run: () => handlers?.move(-1) },
    // Left/right move the text cursor while typing.
    { id: "opcode-feed.adjust.next", bind: "right,l", enabled: idle, run: () => handlers?.adjust?.(1) },
    { id: "opcode-feed.adjust.previous", bind: "left,h", enabled: idle, run: () => handlers?.adjust?.(-1) },
    // While typing, the box's own submit handles enter, and space is text.
    { id: "opcode-feed.activate", bind: "return,space", enabled: idle, run: () => handlers?.activate() },
    { id: "opcode-feed.search", bind: "/", enabled: idle, run: () => { setTyping(true) } },
    { id: "opcode-feed.refresh", bind: "r", enabled: idle, run: () => void props.feeds.refreshAll() },
  ])

  const escLabel = () => typing() ? "done" : picking() ? "back" : query() ? "clear search" : scope() ? "all feeds" : "close"
  const placeholder = () => picking() ? "search feeds" : tabs[tab()]!.placeholder
  const tabProps = (): TabProps => ({ feeds: props.feeds, height: bodyHeight(), width: width() - 4, query, typing, reset, handle: (next) => { handlers = next } })
  const browse = { scope, picking, setPicking, pick: (feed: string | undefined) => { setScope(feed); setPicking(false); reset() } }
  return (
    <box width="100%" flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} backgroundColor={palette.background}
      onSizeChange={function () { setWidth(this.width) }}>
      <box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} paddingBottom={1}>
        <box flexDirection="row" gap={1}>
          <For each={tabs}>{(entry, index) => (
            <box border borderColor={index() === tab() ? palette.value : palette.border} paddingLeft={1} paddingRight={1}
              onMouseDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); switchTab(index() - tab()) }}>
              <text fg={index() === tab() ? palette.value : palette.muted}>{entry.label}</text>
            </box>
          )}</For>
        </box>
        <box flexDirection="row">
          <Show when={loading()}><text fg={palette.muted}>refreshing  </text></Show>
          <KeyHints items={[{ key: "esc", label: escLabel(), command: "opcode-feed.close" }]} />
        </box>
      </box>
      {/* One box in one place on every tab; only its meaning changes. A chosen feed shows as its prefix. */}
      <Card compact>
        <box flexDirection="row" minWidth={0}>
          <Show when={scope() && !picking()}>
            <text wrapMode="none" flexShrink={0} fg={palette.value}>{props.feeds.title(scope()!)} › </text>
          </Show>
          <Show when={typing()} fallback={
            <text wrapMode="none" flexGrow={1} minWidth={0} fg={palette.muted}>
              <span style={{ fg: palette.text }}>/</span> {query() ? <span style={{ fg: palette.value }}>{query()}</span> : placeholder()}
            </text>
          }>
            <input focused flexGrow={1} value={query()} placeholder={placeholder()} onInput={setQuery} onSubmit={() => handlers?.activate()}
              textColor={palette.text} focusedTextColor={palette.text} placeholderColor={palette.muted} />
          </Show>
        </box>
      </Card>
      <box paddingTop={1} flexDirection="column" minWidth={0}>
        <Show when={current() === "status"}><Browser {...tabProps()} {...browse} kind="status" /></Show>
        <Show when={current() === "upcoming"}><Browser {...tabProps()} {...browse} kind="upcoming" /></Show>
        <Show when={current() === "releases"}><Browser {...tabProps()} {...browse} kind="releases" /></Show>
        <Show when={current() === "subscribe"}><Subscribe {...tabProps()} /></Show>
        <Show when={current() === "settings"}><Settings {...tabProps()} /></Show>
      </box>
    </box>
  )
}

const itemID = (index: number) => `opcode-feed.item.${index}`

function Detail(props: { entry: TimelineEntry; now: number; focused: boolean; index: number }) {
  const palette = usePalette()
  const style = () => phaseStyle(props.entry.phase, palette)
  return (
    // Every item keeps its border so focus moves without shifting layout.
    <box id={itemID(props.index)} flexDirection="column" minWidth={0} flexShrink={0} border paddingLeft={1} paddingRight={1}
      borderColor={props.focused ? palette.value : palette.background}>
      <box flexDirection="row" justifyContent="space-between" gap={2} minWidth={0}>
        <text wrapMode="none" minWidth={0} flexShrink={1} fg={style().color}>
          {style().glyph} {style().strong ? <b>{props.entry.status ?? props.entry.source}</b> : props.entry.status ?? props.entry.source}
          <Show when={props.entry.status}><span style={{ fg: palette.muted }}>  {props.entry.source}</span></Show>
        </text>
        <text wrapMode="none" flexShrink={0} fg={palette.muted}>{relative(props.entry.time, props.now)} · {clockTime(props.entry.time)}</text>
      </box>
      <box flexDirection="column" minWidth={0} paddingLeft={2}>
        <text minWidth={0} wrapMode="word" fg={style().title}>{style().strong ? <b>{props.entry.title}</b> : props.entry.title}</text>
        <Show when={props.entry.summary}><text minWidth={0} wrapMode="word" fg={palette.muted}>{props.entry.summary}</text></Show>
        <Show when={props.entry.link}><text minWidth={0} wrapMode="none" fg={props.focused ? palette.value : palette.border}>{props.entry.link}</text></Show>
      </box>
    </box>
  )
}

/** Status, Upcoming, and Releases: enter opens the focused item's link; f narrows to one feed of the tab's kind. */
function Browser(props: TabProps & {
  kind: "status" | "upcoming" | "releases"
  scope: Accessor<string | undefined>; picking: Accessor<boolean>; setPicking(on: boolean): void; pick(feed: string | undefined): void
}) {
  const api = usePlugin()
  const palette = usePalette()
  const timeline = createMemo(() => props.feeds.timeline("feed", props.scope()))
  const settings = () => props.feeds.settings()
  const filter = (entries: readonly TimelineEntry[]) => entries.filter((entry) => matches(entry, props.query()))
  const window = () => windowLabel(settings().windowHours).toUpperCase()
  const feedKind: FeedKind = props.kind === "releases" ? "release" : "status"
  const ofKind = <T extends { kind: FeedKind }>(entries: readonly T[]) => entries.filter((entry) => entry.kind === feedKind)
  const recentTitle = () => props.scope() ? `LATEST ${FEED_HISTORY}` : `LAST ${window()}`
  const groups = createMemo(() => props.kind === "upcoming"
    ? [{ title: props.scope() ? "SCHEDULED" : `NEXT ${window()}`, entries: filter(timeline().upcoming) }]
    : props.kind === "releases"
      ? [{ title: recentTitle(), entries: filter(ofKind(timeline().recent)) }]
      : [
        { title: "IN PROGRESS", entries: filter(timeline().current) },
        { title: recentTitle(), entries: filter(ofKind(timeline().recent)) },
      ])
  const subscribed = () => props.feeds.subscriptions().some((subscription) => kindOf(subscription, presets) === feedKind)
  const items = createMemo(() => groups().flatMap((group) => group.entries))
  const offsets = createMemo(() => groups().map((_, index) => groups().slice(0, index).reduce((sum, group) => sum + group.entries.length, 0)))
  let scroll: ScrollBoxRenderable | undefined
  const focus = useFocus(items, (entry) => entry.key, () => scroll, itemID)
  const handlers: TabHandlers = {
    move: focus.move,
    activate() {
      const entry = focus.current()
      if (!entry) return
      if (!entry.link) { api.ui.toast.show({ title: "Feed", message: "This item has no link.", variant: "warning" }); return }
      try {
        openURL(entry.link)
        api.ui.toast.show({ title: "Feed", message: `Opening ${entry.link}`, variant: "info" })
      } catch (error) {
        api.ui.toast.show({ title: "Feed", message: errorMessage(error), variant: "error" })
      }
    },
  }
  props.handle(handlers)
  // The picker opens on the focused item's feed, so f then enter shows more of it.
  const [initial, setInitial] = createSignal<string>()
  useDialogCommands(api, () => [{
    id: "opcode-feed.pick", bind: "f", enabled: () => !props.typing() && !props.picking(),
    run: () => { setInitial(focus.current()?.url ?? props.scope()); props.reset(); props.setPicking(true) },
  }])
  return (
    <Show when={!props.picking()} fallback={
      <FeedPicker feeds={props.feeds} kind={feedKind} query={props.query} height={props.height} width={props.width} initial={initial()}
        handle={props.handle} restore={() => props.handle(handlers)} pick={props.pick} />
    }>
      <TabFrame height={props.height} hints={[
        ...navigationHints,
        { key: "enter", label: "open link", command: "opcode-feed.activate" },
        { key: "f", label: props.scope() ? "change feed" : "feed", command: "opcode-feed.pick" },
        { key: "/", label: "search", command: "opcode-feed.search" },
        { key: "r", label: "refresh", command: "opcode-feed.refresh" },
      ]}>
        <Show when={subscribed()} fallback={
          <CenterEmpty title={feedKind === "status" ? "No status pages yet" : "No release feeds yet"} description="Subscribe to one in the Subscribe tab." />
        }>
          <scrollbox ref={scroll} height={props.height}>
            <box flexDirection="column" minWidth={0}>
              <Show when={props.kind !== "upcoming" && !props.query()}>
                <Show when={props.kind === "status" && timeline().operational.length}>
                  <text minWidth={0} wrapMode="word" fg={palette.muted}>✓ Operational: {timeline().operational.join(" · ")}</text>
                </Show>
                <For each={ofKind(timeline().unreachable)}>{(failure) => (
                  <text minWidth={0} wrapMode="word" fg={palette.error}>! {failure.source} unreachable: {failure.error}</text>
                )}</For>
              </Show>
              <For each={groups()}>{(group, groupIndex) => (
                <Show when={group.entries.length || groupIndex() === groups().length - 1}>
                  <text fg={palette.accent} flexShrink={0} paddingTop={1}><b>{group.title}</b></text>
                  <For each={group.entries} fallback={
                    <text fg={palette.muted}>{props.query() ? "No matching items." : timeline().pending ? "Loading…" : "Nothing in this window."}</text>
                  }>{(entry, index) => (
                    <Detail entry={entry} now={props.feeds.now()} index={offsets()[groupIndex()]! + index()} focused={offsets()[groupIndex()]! + index() === focus.focused()} />
                  )}</For>
                </Show>
              )}</For>
            </box>
          </scrollbox>
        </Show>
      </TabFrame>
    </Show>
  )
}

const scopeLabels: Record<SurfaceScope, string> = { both: "Both", sidebar: "Sidebar", feed: "/feed", none: "None" }
const scopes = scopeChoices.map((scope) => ({ value: scope, label: scopeLabels[scope] }))

interface SettingRow<Value> {
  id: string
  label: string
  description: string
  choices: readonly { value: Value; label: string }[]
  current(settings: FeedSettings): Value
  update(value: Value): Partial<FeedSettings>
}

const settingRows = [
  {
    id: "window", label: "Time window",
    description: "How far back Status and Releases look, and how far ahead Upcoming looks. In-progress items always show.",
    choices: windowChoices.map((hours) => ({ value: hours as number, label: windowShort(hours) })),
    current: (settings: FeedSettings) => settings.windowHours,
    update: (windowHours: number) => ({ windowHours }),
  } satisfies SettingRow<number>,
  {
    id: "resolved", label: "Show resolved",
    description: "Where resolved and completed incidents appear.",
    choices: scopes,
    current: (settings: FeedSettings) => settings.resolved,
    update: (resolved: SurfaceScope) => ({ resolved }),
  } satisfies SettingRow<SurfaceScope>,
  {
    id: "releases", label: "Sidebar releases",
    description: "Whether posts from release feeds also appear in the sidebar. The Releases tab always has them.",
    choices: [{ value: false, label: "No" }, { value: true, label: "Yes" }],
    current: (settings: FeedSettings) => settings.sidebarReleases,
    update: (sidebarReleases: boolean) => ({ sidebarReleases }),
  } satisfies SettingRow<boolean>,
  {
    id: "sidebar", label: "Sidebar items",
    description: "How many items the sidebar lists, in-progress first, before pointing to /feed. Up to two scheduled items follow them.",
    choices: sidebarItemChoices.map((count) => ({ value: count as number, label: `${count}` })),
    current: (settings: FeedSettings) => settings.sidebarItems,
    update: (sidebarItems: number) => ({ sidebarItems }),
  } satisfies SettingRow<number>,
] as SettingRow<unknown>[]

/** Every choice stays visible; ←/→ move between them, stopping at either end. */
function Settings(props: TabProps) {
  const palette = usePalette()
  const rows = createMemo(() => settingRows.filter((row) =>
    matchesText([row.label, row.description, ...row.choices.map((choice) => choice.label)].join(" "), props.query())))
  const focus = useFocus(rows, (row) => row.id)
  props.handle({
    move: focus.move,
    activate() {},
    adjust(direction) {
      const row = focus.current()
      if (!row) return
      const index = row.choices.findIndex((choice) => choice.value === row.current(props.feeds.settings()))
      const next = row.choices[Math.max(0, Math.min(row.choices.length - 1, index + direction))]!
      props.feeds.updateSettings(row.update(next.value))
    },
  })
  return (
    <TabFrame height={props.height} hints={[...navigationHints, { key: "←/→ h/l", label: "change", command: "opcode-feed.adjust.next" }, { key: "/", label: "search", command: "opcode-feed.search" }]}>
      <box flexDirection="column" minWidth={0} gap={1}>
        <For each={rows()} fallback={<text fg={palette.muted}>No matching settings.</text>}>{(row, index) => {
          const selected = () => index() === focus.focused()
          return (
            <box flexDirection="column" minWidth={0}>
              <box flexDirection="row" height={1} gap={2} backgroundColor={selected() ? palette.selectedBackground : undefined}>
                <text width={18} flexShrink={0} fg={selected() ? palette.selectedText : palette.text}>{selected() ? ">" : " "} {row.label}</text>
                <box flexDirection="row" gap={1}>
                  <For each={row.choices}>{(choice) => {
                    const active = () => choice.value === row.current(props.feeds.settings())
                    return <text fg={selected() ? palette.selectedText : active() ? palette.value : palette.muted}>{active() ? `[${choice.label}]` : ` ${choice.label} `}</text>
                  }}</For>
                </box>
              </box>
              <box paddingLeft={2}><text minWidth={0} wrapMode="word" fg={palette.muted}>{row.description}</text></box>
            </box>
          )
        }}</For>
      </box>
    </TabFrame>
  )
}
