/** @jsxImportSource @opentui/solid */

import { errorMessage, formatCount, formatMoney } from "@opcode/core"
import { createRefresh, type RefreshState, type SetTimer } from "@opcode/core/refresh"
import { Picker, TabbedDialog, TabFrame, useFocus, useTab, type PickerOption, type TabHandlers } from "@opcode/tabs"
import { matchesText } from "@opcode/tabs/format"
import { Card, CenterEmpty, StatCard, usePalette, useText, type KeyHint } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import type { LocationRef } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, Show, untrack, type Accessor, type Signal } from "solid-js"
import { createCostService, type CostService } from "./client.js"
import { DATE_RANGES, localDay, rangeLabel, type Breakdown, type Dashboard, type DashboardFilter, type LongTurn, type TimeBreakdown, type TimeDashboard } from "./domain.js"

export const PREFIX = "opcode-cost"

/** Injectable so tests drive refreshes without real timers. Each returns its cancel function. */
export interface Timers {
  interval(run: () => void): () => void
  /** One-shot debounce and timeout timers for ledger reads. */
  timer: SetTimer
}

export type ImportState = { type: "idle" } | { type: "running" } | { type: "failed"; message: string }

/** What the dialog reads from the plugin: the connected location and its history import. */
export interface CostHost {
  timers: Timers
  location(): LocationRef
  /** Changes when an import settles or r is pressed, so the open view rereads. */
  revision(): number
  importState(): ImportState
  refresh(): void
}

/** The project's label is kept for the search box's prefix; only the filter fields reach the server. */
type Filter = DashboardFilter & { project?: string }

const DEFAULT_FILTER: Filter = { range: "30d" }
const WIDE = 90

/** Cost and Time share one filter, kept while the dialog is open. */
export function CostDialog(props: { host: CostHost }) {
  const filter = createSignal<Filter>(DEFAULT_FILTER)
  return (
    <TabbedDialog prefix={PREFIX} refreshing={props.host.importState().type === "running"} refresh={() => props.host.refresh()} tabs={[
      { label: "Cost", placeholder: "search models, projects, and dates", render: () => (
        <Ledger host={props.host} filter={filter} load={(service, filter, signal) => service.dashboard(filter, signal)}
          content={(dashboard) => <CostView dashboard={dashboard()} filter={filter[0]()} />} />
      ) },
      { label: "Time", placeholder: "search models, projects, dates, and turns", render: () => (
        <Ledger host={props.host} filter={filter} load={(service, filter, signal) => service.time(filter, signal)} turns={(time) => time.longest}
          content={(time, turns) => <TimeView time={time()} filter={filter[0]()} turns={turns} />} />
      ) },
    ]} />
  )
}

/** The longest turns, as the search narrows them; ↑/↓ select one and enter opens its session. */
interface Turns {
  rows: Accessor<readonly LongTurn[]>
  focused: Accessor<number>
  open(index: number): void
}

type Picking = "date" | "project" | "model"

/** One tab's ledger read, filter pickers, and frame. The read stays mounted while a picker replaces the frame. */
function Ledger<T>(props: {
  host: CostHost
  filter: Signal<Filter>
  load(service: CostService, filter: DashboardFilter, signal: AbortSignal): Promise<T>
  turns?(value: T): readonly LongTurn[]
  content(value: Accessor<T>, turns: Turns): JSX.Element
}) {
  const api = usePlugin()
  const tab = useTab()
  const palette = usePalette()
  const { shorten } = useText()
  const [filter, setFilter] = props.filter
  const [picking, setPicking] = createSignal<Picking>()
  const [read, setRead] = createSignal<RefreshState<T>>({ loading: true })
  // A failure with loaded data is a stale-data warning; without it, the tab has nothing honest to show.
  const error = () => read().value === undefined ? read().error : undefined
  const warning = () => read().value === undefined ? undefined : read().error
  const query = createMemo(() => {
    const { range, projectID, model } = filter()
    const { directory, workspaceID } = props.host.location()
    return { key: JSON.stringify([range, projectID ?? null, model ?? null, directory, workspaceID ?? null]), filter: { range, projectID, model }, location: { directory, workspaceID } }
  }, undefined, { equals: (previous, next) => previous.key === next.key })
  // Polls, usage events, and import revisions coalesce behind the in-flight read.
  const refresh = createRefresh((signal) => {
    const { filter, location } = untrack(query)
    return props.load(createCostService(api.client, location), filter, signal)
  }, setRead, { delay: 100, timer: props.host.timers.timer })
  createEffect(on(query, () => {
    // Drop stale values only for a different filter or location, not a background refresh.
    refresh.reset()
    void refresh.refresh()
  }))
  createEffect(on(props.host.revision, () => refresh.schedule(), { defer: true }))
  // Options belong to the location they were read from.
  createEffect(on(() => query().location, () => setPicking(undefined), { defer: true }))
  onCleanup(() => refresh.dispose())
  onCleanup(props.host.timers.interval(() => refresh.schedule()))
  onCleanup(api.data.on("session.usage.updated", () => refresh.schedule()))

  let scroll: ScrollBoxRenderable | undefined
  const turnRows = createMemo(() => {
    const value = read().value
    return value === undefined || !props.turns ? [] : props.turns(value).filter((turn) => matchesText(`${turn.title} ${turn.project} ${turn.model}`, tab.query()))
  })
  const turnKey = (turn: LongTurn) => `${turn.sessionID}:${turn.start}`
  const focus = useFocus(turnRows, turnKey, () => scroll, (index) => tab.command(`turn.${index}`))
  // Opening a turn leaves the dialog for its session.
  const open = (turn: LongTurn | undefined) => {
    if (!turn) return
    focus.focus(turnKey(turn))
    api.ui.dialog.clear()
    api.ui.router.navigate({ type: "session", sessionID: turn.sessionID })
  }
  const turns: Turns = { rows: turnRows, focused: focus.focused, open: (index) => open(turnRows()[index]) }
  const handlers: TabHandlers = {
    // Without turns to select, ↑/↓ scroll.
    move: (by) => { if (turnRows().length) focus.move(by); else if (scroll && !scroll.isDestroyed) scroll.scrollBy(by) },
    activate: () => open(focus.current()),
    prefix: () => {
      const { range, project, model } = filter()
      return shorten([rangeLabel(range), project, model].filter(Boolean).join(" · "), Math.max(12, Math.floor(tab.width() / 2)))
    },
  }

  const idle = () => !tab.typing() && !picking()
  const pick = (kind: Picking) => { tab.reset(); setPicking(kind) }
  useDialogCommands(api, () => [
    { id: tab.command("date"), bind: "d", enabled: idle, run: () => pick("date") },
    { id: tab.command("project"), bind: "p", enabled: idle, run: () => pick("project") },
    { id: tab.command("model"), bind: "m", enabled: idle, run: () => pick("model") },
    { id: tab.command("reset"), bind: "x", enabled: idle, run: () => setFilter(DEFAULT_FILTER) },
  ])
  const hints = (): KeyHint[] => [
    ...tab.navigation,
    ...props.turns ? [{ key: "enter", label: "open turn", command: tab.command("activate") }] : [],
    { key: "d", label: "date", command: tab.command("date") },
    { key: "p", label: "project", command: tab.command("project") },
    { key: "m", label: "model", command: tab.command("model") },
    { key: "x", label: "reset", command: tab.command("reset") },
    { key: "/", label: "search", command: tab.command("search") },
    { key: "r", label: "refresh", command: tab.command("refresh") },
  ]
  const importFailure = () => {
    const state = props.host.importState()
    return state.type === "failed" ? state.message : undefined
  }
  return (
    <Show when={picking()} fallback={
      <Board handlers={handlers} hints={hints()} ref={(element) => { scroll = element }}
        empty={read().value === undefined ? { title: error() ? "Unable to read ledger" : "Loading server ledger…", description: error() } : undefined}
        header={<>
          <Show when={importFailure()}>{(message) => <text minWidth={0} wrapMode="word" fg={palette.warning}>! History import failed: {message()}. Press r to retry.</text>}</Show>
          <Show when={warning()}>{(message) => <text minWidth={0} wrapMode="word" fg={palette.warning}>! Refresh failed: {message()}; showing last loaded usage.</text>}</Show>
        </>}>
        <Show when={read().value !== undefined}>{props.content(() => read().value!, turns)}</Show>
      </Board>
    }>
      {(kind) => <FilterPicker kind={kind()} filter={filter()} location={query().location}
        pick={(change) => { setFilter({ ...filter(), ...change }); setPicking(undefined) }} close={() => setPicking(undefined)} />}
    </Show>
  )
}

/** The tab's keys, its warnings, and the scrolled content (or a centered state when nothing is loaded). */
/** Remounts when a picker closes: the picker's handlers replaced the tab's, and leaving clears them rather than restoring these. */
function Board(props: {
  handlers: TabHandlers
  hints: readonly KeyHint[]
  ref(element: ScrollBoxRenderable): void
  header: JSX.Element
  empty?: { title: string; description?: string }
  children: JSX.Element
}) {
  const tab = useTab()
  tab.handle(props.handlers)
  return (
    <TabFrame hints={props.hints}>
      {props.header}
      <Show when={props.empty} fallback={
        <scrollbox ref={props.ref} id={tab.command("content")} flexGrow={1} minHeight={0}>
          <box flexDirection="column" flexShrink={0} gap={1} minWidth={0}>{props.children}</box>
        </scrollbox>
      }>
        {(empty) => <CenterEmpty title={empty().title} description={empty().description} />}
      </Show>
    </TabFrame>
  )
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Date choices are fixed; project and model choices are what the server recorded in the selected range. */
function FilterPicker(props: { kind: Picking; filter: Filter; location: LocationRef; pick(change: Partial<Filter>): void; close(): void }) {
  const api = usePlugin()
  const palette = usePalette()
  if (props.kind === "date") {
    return <Picker all="All time" noun="date ranges" action="show range" initial={props.filter.range === "all" ? undefined : props.filter.range}
      options={DATE_RANGES.filter((range) => range !== "all").map((range) => ({ key: range, label: capitalize(rangeLabel(range)) }))}
      pick={(range) => props.pick({ range: (range ?? "all") as Filter["range"] })} close={props.close} />
  }
  const kind = props.kind
  const noun = kind === "project" ? "projects" : "models"
  const [options, setOptions] = createSignal<PickerOption[]>()
  const [failure, setFailure] = createSignal<string>()
  const abort = new AbortController()
  onCleanup(() => abort.abort())
  createCostService(api.client, props.location).dashboard({ range: props.filter.range }, abort.signal).then((dashboard) => {
    if (abort.signal.aborted) return
    setOptions(kind === "project"
      ? dashboard.projectOptions.map((option) => ({ key: option.id, label: option.label, detail: option.directory }))
      : dashboard.modelOptions.map((option) => ({ key: option.id, label: option.label })))
  }, (error: unknown) => { if (!abort.signal.aborted) setFailure(errorMessage(error)) })
  return (
    <Show when={options()} fallback={<Waiting close={props.close}>
      <text minWidth={0} wrapMode="word" fg={failure() ? palette.error : palette.muted}>{failure() ? `! Couldn't load ${noun}: ${failure()}` : `Loading ${noun}…`}</text>
    </Waiting>}>
      {(options) => <Picker options={options()} all={`All ${noun}`} noun={noun} action="filter"
        initial={kind === "project" ? props.filter.projectID : props.filter.model}
        pick={(key) => props.pick(kind === "project"
          ? { projectID: key, project: options().find((option) => option.key === key)?.label }
          : { model: key })}
        close={props.close} />}
    </Show>
  )
}

/** Stands in for a picker until its options load; esc goes back. */
function Waiting(props: { close(): void; children: JSX.Element }) {
  const tab = useTab()
  tab.handle({ move() {}, activate() {}, back: () => ({ label: "back", run: props.close }) })
  return <TabFrame hints={[{ key: "esc", label: "back", command: tab.command("close") }]}>{props.children}</TabFrame>
}

function CostView(props: { dashboard: Dashboard; filter: DashboardFilter }) {
  const total = () => props.dashboard.total
  // One rule per view: with no recorded cost (subscriptions report $0), every figure is tokens.
  const priced = () => total().cost > 0
  const rows = (rows: readonly Breakdown[]) => rows.map((row) => costRow(row, priced()))
  const cards = () => [
    ...priced() ? [{ label: "TOTAL COST", value: formatMoney(total().cost), detail: `${formatCount(total().messages)} recorded messages` }] : [],
    { label: "ALL TOKENS", value: formatTokens(total().tokens),
      detail: priced() ? `${formatTokens(total().input)} input` : `${formatTokens(total().input)} input  ${formatCount(total().messages)} msg` },
    { label: "OUTPUT", value: formatTokens(total().output), detail: `${formatTokens(total().reasoning)} reasoning` },
    { label: "CACHE", value: formatTokens(total().cacheRead + total().cacheWrite), detail: `${formatTokens(total().cacheRead)} read` },
  ]
  return (
    <Panels filter={props.filter} cards={cards()} models={rows(props.dashboard.models)} projects={rows(props.dashboard.projects)} daily={rows(props.dashboard.daily)}
      empty={total().messages > 0 ? undefined : "No recorded usage"} />
  )
}

function TimeView(props: { time: TimeDashboard; filter: DashboardFilter; turns: Turns }) {
  const total = () => props.time.total
  return (
    <Panels filter={props.filter} models={props.time.models.map(timeRow)} projects={props.time.projects.map(timeRow)} daily={props.time.daily.map(timeRow)}
      empty={total().turns > 0 ? undefined : "No recorded turns"} cards={[
        { label: "AGENT TIME", value: formatDuration(total().agent), detail: `${formatCount(total().turns)} turns` },
        { label: "WAITING ON YOU", value: formatDuration(total().wait), detail: "at most 30m per wait" },
        { label: "PARALLEL", value: formatDuration(total().parallel), detail: `peak ${formatCount(total().peak)} sessions` },
      ]}>
      <LongestPanel turns={props.turns} />
    </Panels>
  )
}

interface Stat { label: string; value: string; detail: string }

/** Totals, then breakdowns by model, project, and day, narrowed by the search. Selecting a model or project hides its own breakdown. */
function Panels(props: {
  filter: DashboardFilter
  cards: readonly Stat[]
  models: BarRow[]
  projects: BarRow[]
  daily: BarRow[]
  empty?: string
  children?: JSX.Element
}) {
  const tab = useTab()
  const wide = () => tab.width() >= WIDE
  const columns = () => wide() ? 1 + Number(!props.filter.model) + Number(!props.filter.projectID) : 1
  // One column stays free for the scrollbar.
  const width = () => Math.floor((tab.width() - columns()) / columns())
  const search = (rows: BarRow[]) => rows.filter((row) => matchesText(row.label, tab.query()))
  return <>
    <box id={tab.command("totals")} flexDirection="row" gap={1} flexShrink={0}>
      <Index each={props.cards.slice(0, wide() ? 4 : 2)}>{(card) => <StatCard compact label={card().label} value={card().value} detail={card().detail} />}</Index>
    </box>
    <Show when={!props.empty} fallback={
      <Card grow minHeight={8}><CenterEmpty title={props.empty!} description="Press r to reconcile this project's history, or change the filters." /></Card>
    }>
      <box flexDirection={wide() ? "row" : "column"} gap={1} flexShrink={0}>
        <Show when={!props.filter.model}><BreakdownPanel title="BY MODEL" rows={search(props.models)} width={width()} /></Show>
        <Show when={!props.filter.projectID}><BreakdownPanel title="BY PROJECT" rows={search(props.projects)} width={width()} /></Show>
        <TrendPanel rows={search(props.daily)} width={width()} />
      </box>
      {props.children}
    </Show>
  </>
}

/** One bar-chart row: `value` sizes the bar, `amount` labels it. */
interface BarRow { id: string; label: string; value: number; amount: string; detail: string }

const costRow = (row: Breakdown, priced: boolean): BarRow => ({
  id: row.id, label: row.label, value: priced ? row.cost : row.tokens,
  amount: priced ? `${formatMoney(row.cost)}  ${formatTokens(row.tokens)} tok` : `${formatTokens(row.tokens)} tok`,
  detail: `${formatCount(row.messages)} msg`,
})
const timeRow = (row: TimeBreakdown): BarRow => ({
  id: row.id, label: row.label, value: row.agent, amount: formatDuration(row.agent),
  detail: `${formatCount(row.turns)} turns  ${formatDuration(row.wait)} wait`,
})

function BreakdownPanel(props: { title: string; rows: BarRow[]; width: number }) {
  const palette = usePalette()
  const { shorten } = useText()
  const max = () => Math.max(0, ...props.rows.map((row) => row.value))
  const width = () => Math.min(20, Math.max(4, props.width - 26))
  return (
    <Panel title={props.title} width={props.width}>
      <For each={props.rows} fallback={<text fg={palette.muted}>No matches.</text>}>{(row) => (
        <box flexDirection="column" paddingBottom={1} flexShrink={0}>
          <box flexDirection="row" justifyContent="space-between" gap={1}>
            <text wrapMode="none" fg={palette.text}>{shorten(row.label, Math.max(4, props.width - row.amount.length - 6))}</text>
            <text wrapMode="none" fg={palette.value}>{row.amount}</text>
          </box>
          <text wrapMode="none" fg={palette.muted}><Bar value={row.value} max={max()} width={width()} />  {row.detail}</text>
        </box>
      )}</For>
    </Panel>
  )
}

function TrendPanel(props: { rows: BarRow[]; width: number }) {
  const palette = usePalette()
  const max = () => Math.max(0, ...props.rows.map((row) => row.value))
  // Bars give way to the labels and amounts, which are measured across rows so the bars line up.
  const bar = () => Math.min(12, Math.max(0, props.width - 6 - Math.max(0, ...props.rows.map((row) => row.label.length + row.amount.length))))
  return (
    <Panel title="DAILY ACTIVITY" width={props.width}>
      <For each={props.rows} fallback={<text fg={palette.muted}>No matches.</text>}>{(row) => (
        <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
          <text wrapMode="none" fg={palette.muted}>{row.label}<Show when={bar()}> <Bar value={row.value} max={max()} width={bar()} /></Show></text>
          <text wrapMode="none" fg={palette.value}>{row.amount}</text>
        </box>
      )}</For>
    </Panel>
  )
}

/** Side by side, panels share the width equally rather than by content. */
function Panel(props: { title: string; width: number; children: JSX.Element }) {
  return (
    <box width={props.width} flexShrink={0} flexDirection="column">
      <Card title={props.title} grow minHeight={8}><box flexDirection="column">{props.children}</box></Card>
    </box>
  )
}

function LongestPanel(props: { turns: Turns }) {
  const tab = useTab()
  const palette = usePalette()
  const { shorten } = useText()
  return (
    <Card title="LONGEST TURNS" minHeight={8}>
      <box flexDirection="column">
        <For each={props.turns.rows()} fallback={<text fg={palette.muted}>No matching turns.</text>}>{(row, index) => {
          const active = () => index() === props.turns.focused()
          const amount = () => formatDuration(row.duration)
          return (
            <box id={tab.command(`turn.${index()}`)} flexDirection="column" flexShrink={0} backgroundColor={active() ? palette.selectedBackground : undefined}
              onMouseDown={(event) => {
                if (event.button !== 0) return
                event.stopPropagation()
                props.turns.open(index())
              }}>
              <box flexDirection="row" justifyContent="space-between" gap={1}>
                <text wrapMode="none" fg={active() ? palette.selectedText : palette.text}>
                  {active() ? "> " : "  "}{shorten(row.title, Math.max(4, tab.width() - amount().length - 8))}
                </text>
                <text wrapMode="none" fg={active() ? palette.selectedText : palette.value}>{amount()}</text>
              </box>
              <text wrapMode="none" fg={active() ? palette.selectedText : palette.muted}>
                {"  "}{shorten(`${row.project}  ${row.model}  ${formatStart(row.start)}`, Math.max(4, tab.width() - 6))}
              </text>
            </box>
          )
        }}</For>
      </box>
    </Card>
  )
}

function Bar(props: { value: number; max: number; width: number }) {
  const palette = usePalette()
  const filled = () => props.value > 0 && props.max > 0 ? Math.min(props.width, Math.max(1, Math.round(props.value / props.max * props.width))) : 0
  return <><span style={{ fg: palette.accent }}>{"#".repeat(filled())}</span><span style={{ fg: palette.track }}>{"-".repeat(props.width - filled())}</span></>
}

const tokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 })

function formatTokens(value: number) {
  return tokens.format(value)
}

function formatDuration(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${seconds}s`
}

function formatStart(at: number) {
  const date = new Date(at)
  return `${localDay(at)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}
