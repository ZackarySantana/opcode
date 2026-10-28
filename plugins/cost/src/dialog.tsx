/** @jsxImportSource @opentui/solid */

import { formatCount, formatMoney } from "@opcode/core"
import { createRefresh, type RefreshState, type SetTimer } from "@opcode/core/refresh"
import { Picker, TabbedDialog, TabFrame, useFocus, useTab, type Color, type TabHandlers } from "@opcode/tabs"
import { matchesText } from "@opcode/tabs/format"
import { Card, CenterEmpty, StatCard, usePalette, useText, type KeyHint } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import type { LocationRef } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createEffect, createMemo, createSignal, Index, on, onCleanup, Show, untrack, type Accessor, type Signal } from "solid-js"
import { createCostService } from "./client.js"
import { DATE_RANGES, rangeLabel, type DateRange, type LongTurn } from "./domain.js"
import { formatDuration, formatStart, formatTokens, isPriced, joinBreakdown, type Dimension, type Ledger } from "./format.js"

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

/** What every tab shares while the dialog is open. */
interface Shared {
  host: CostHost
  range: Signal<DateRange>
  read: Accessor<RefreshState<Ledger>>
}

const WIDE = 90
const BAR = 20

/** One read and one date range serve every tab; reopening starts again from the last 30 days. */
export function CostDialog(props: { host: CostHost }) {
  const api = usePlugin()
  const range = createSignal<DateRange>("30d")
  const [read, setRead] = createSignal<RefreshState<Ledger>>({ loading: true })
  const query = createMemo(() => {
    const { directory, workspaceID } = props.host.location()
    return { key: JSON.stringify([range[0](), directory, workspaceID ?? null]), range: range[0](), location: { directory, workspaceID } }
  }, undefined, { equals: (previous, next) => previous.key === next.key })
  // Polls, usage events, and import revisions coalesce behind the in-flight read.
  const refresh = createRefresh(async (signal) => {
    const { range, location } = untrack(query)
    const service = createCostService(api.client, location)
    const [usage, time] = await Promise.all([service.dashboard(range, signal), service.time(range, signal)])
    return { usage, time }
  }, setRead, { delay: 100, timer: props.host.timers.timer })
  createEffect(on(query, () => {
    // Drop stale values only for a different range or location, not a background refresh.
    refresh.reset()
    void refresh.refresh()
  }))
  createEffect(on(props.host.revision, () => refresh.schedule(), { defer: true }))
  onCleanup(() => refresh.dispose())
  onCleanup(props.host.timers.interval(() => refresh.schedule()))
  onCleanup(api.data.on("session.usage.updated", () => refresh.schedule()))

  const shared: Shared = { host: props.host, range, read }
  // Opening a turn leaves the dialog for its session.
  const open = (turn: LongTurn) => {
    api.ui.dialog.clear()
    api.ui.router.navigate({ type: "session", sessionID: turn.sessionID })
  }
  const breakdown = (label: string, noun: string, dimension: Dimension) => ({
    label, placeholder: `search ${noun}`,
    render: () => <Page shared={shared} list={{ rows: (ledger) => entries(ledger, dimension), empty: "No recorded usage." }} />,
  })
  return (
    <TabbedDialog prefix={PREFIX} refreshing={props.host.importState().type === "running"} refresh={() => props.host.refresh()} tabs={[
      { label: "Overview", placeholder: "nothing to search on the overview", render: () => <Page shared={shared}>{(ledger) => <Overview ledger={ledger()} />}</Page> },
      breakdown("Models", "models", "models"),
      breakdown("Projects", "projects", "projects"),
      breakdown("Daily", "dates", "daily"),
      { label: "Turns", placeholder: "search turns by title, project, or model", render: () => (
        <Page shared={shared} list={{ rows: (ledger) => ledger.time.longest.map((turn) => turnEntry(turn, () => open(turn))), empty: "No recorded turns.", action: "open session" }} />
      ) },
    ]} />
  )
}

/** One list row: label and amount, then an optional bar and the details. */
interface Entry {
  key: string
  label: string
  amount: string
  detail: string
  /** The bar's fill, from 0 to 1; without it, the row has no bar. */
  share?: number
  /** What the search matches. */
  search: string
  open?(): void
}

/** A tab's rows; ↑/↓ move the selection through them, and enter opens one that can be opened. */
interface List {
  rows(ledger: Ledger): readonly Entry[]
  /** Shown when the range has no rows at all. */
  empty: string
  /** The enter hint, for rows that open. */
  action?: string
}

/** One tab: the date picker, warnings, and the ledger as a list or other content (or a centered state until it loads). */
function Page(props: { shared: Shared; list?: List; children?: (ledger: Accessor<Ledger>) => JSX.Element }) {
  const api = usePlugin()
  const tab = useTab()
  const palette = usePalette()
  const [range, setRange] = props.shared.range
  const [picking, setPicking] = createSignal(false)
  const read = props.shared.read
  // A failure with loaded data is a stale-data warning; without it, the tab has nothing honest to show.
  const error = () => read().value === undefined ? read().error : undefined
  const warning = () => read().value === undefined ? undefined : read().error
  const all = createMemo(() => {
    const value = read().value
    return value && props.list ? props.list.rows(value) : []
  })
  const rows = createMemo(() => all().filter((row) => matchesText(row.search, tab.query())))
  // A signal, so the selection is scrolled back into view when the picker closes and the list remounts.
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()
  const id = (index: number) => tab.command(`row.${index}`)
  const focus = useFocus(rows, (row) => row.key, scroll, id)
  const select = (row: Entry | undefined) => {
    if (!row) return
    focus.focus(row.key)
    row.open?.()
  }
  const handlers: TabHandlers = {
    // Without rows to select, ↑/↓ scroll.
    move: (by) => {
      const box = scroll()
      if (props.list) focus.move(by)
      else if (box && !box.isDestroyed) box.scrollBy(by)
    },
    activate: () => select(focus.current()),
    prefix: () => rangeLabel(range()),
  }
  useDialogCommands(api, () => [
    { id: tab.command("date"), bind: "d", enabled: () => !tab.typing() && !picking(), run: () => { tab.reset(); setPicking(true) } },
  ])
  const hints = (): KeyHint[] => [
    ...tab.navigation,
    ...props.list?.action ? [{ key: "enter", label: props.list.action, command: tab.command("activate") }] : [],
    { key: "d", label: "date", command: tab.command("date") },
    ...props.list ? [{ key: "/", label: "search", command: tab.command("search") }] : [],
    { key: "r", label: "refresh", command: tab.command("refresh") },
  ]
  const importFailure = () => {
    const state = props.shared.host.importState()
    return state.type === "failed" ? state.message : undefined
  }
  return (
    <Show when={picking()} fallback={
      <Board handlers={handlers} hints={hints()} ref={setScroll}
        empty={read().value === undefined ? { title: error() ? "Unable to read ledger" : "Loading server ledger…", description: error() } : undefined}
        header={<>
          <Show when={importFailure()}>{(message) => <text minWidth={0} wrapMode="word" fg={palette.warning}>! History import failed: {message()}. Press r to retry.</text>}</Show>
          <Show when={warning()}>{(message) => <text minWidth={0} wrapMode="word" fg={palette.warning}>! Refresh failed: {message()}; showing last loaded usage.</text>}</Show>
        </>}>
        <Show when={read().value}>{(ledger) => (
          <Show when={props.list} fallback={props.children?.(ledger)}>{(list) => (
            <Index each={rows()} fallback={<text fg={palette.muted}>{all().length ? "No matches." : list().empty}</text>}>{(row, index) => (
              <box id={id(index)} flexDirection="column" flexShrink={0} backgroundColor={index === focus.focused() ? palette.selectedBackground : undefined}
                onMouseDown={(event) => {
                  if (event.button !== 0) return
                  event.stopPropagation()
                  select(row())
                }}>
                <EntryRow entry={row()} selected={index === focus.focused()} />
              </box>
            )}</Index>
          )}</Show>
        )}</Show>
      </Board>
    }>
      <Picker all="All time" noun="date ranges" action="show range" initial={range() === "all" ? undefined : range()}
        options={DATE_RANGES.filter((range) => range !== "all").map((range) => ({ key: range, label: capitalize(rangeLabel(range)) }))}
        pick={(next) => { setRange((next ?? "all") as DateRange); setPicking(false) }} close={() => setPicking(false)} />
    </Show>
  )
}

/**
 * The tab's keys, its warnings, and the scrolled content (or a centered state when nothing is loaded). Remounts when
 * the picker closes: the picker's handlers replaced the tab's, and leaving clears them rather than restoring these.
 */
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
          <box flexDirection="column" flexShrink={0} minWidth={0} gap={1}>{props.children}</box>
        </scrollbox>
      }>
        {(empty) => <CenterEmpty title={empty().title} description={empty().description} />}
      </Show>
    </TabFrame>
  )
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

interface Stat { label: string; value: string; detail: string }

/** Usage totals, then time totals, in rows of cards. */
function Overview(props: { ledger: Ledger }) {
  const tab = useTab()
  const usage = () => props.ledger.usage.total
  const time = () => props.ledger.time.total
  const priced = () => isPriced(props.ledger.usage)
  const groups = (): Stat[][] => [
    [
      ...priced() ? [{ label: "TOTAL COST", value: formatMoney(usage().cost), detail: `${formatCount(usage().messages)} recorded messages` }] : [],
      { label: "ALL TOKENS", value: formatTokens(usage().tokens),
        detail: priced() ? `${formatTokens(usage().input)} input` : `${formatTokens(usage().input)} input  ${formatCount(usage().messages)} msg` },
      { label: "OUTPUT", value: formatTokens(usage().output), detail: `${formatTokens(usage().reasoning)} reasoning` },
      { label: "CACHE", value: formatTokens(usage().cacheRead + usage().cacheWrite), detail: `${formatTokens(usage().cacheRead)} read` },
    ],
    [
      { label: "AGENT TIME", value: formatDuration(time().agent), detail: `${formatCount(time().turns)} turns` },
      { label: "WAITING ON YOU", value: formatDuration(time().wait), detail: "at most 30m per wait" },
      { label: "PARALLEL", value: formatDuration(time().parallel), detail: `peak ${formatCount(time().peak)} sessions` },
    ],
  ]
  const size = () => tab.width() >= WIDE ? 4 : 2
  const rows = () => groups().flatMap((group) => Array.from({ length: Math.ceil(group.length / size()) }, (_, row) => group.slice(row * size(), (row + 1) * size())))
  // Cards share their row's width explicitly: sized by their text, they'd push past the dialog's edge. One column is
  // left for the scrollbar.
  const cardWidth = (count: number, index: number) => {
    const room = tab.width() - 1 - (count - 1)
    const width = Math.floor(room / count)
    return index === count - 1 ? room - width * (count - 1) : width
  }
  return (
    <box id={tab.command("totals")} flexDirection="column" gap={1} flexShrink={0}>
      <Index each={rows()}>{(row) => (
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Index each={row()}>{(card, index) => <box width={cardWidth(row().length, index)}><StatCard compact label={card().label} value={card().value} detail={card().detail} /></box>}</Index>
        </box>
      )}</Index>
      <Show when={usage().messages === 0 && time().turns === 0}>
        <Card grow minHeight={8}><CenterEmpty title="No recorded usage" description="Press r to reconcile this project's history, or change the date range." /></Card>
      </Show>
    </box>
  )
}

function entries(ledger: Ledger, dimension: Dimension): Entry[] {
  const priced = isPriced(ledger.usage)
  return joinBreakdown(ledger, dimension).map(({ id, label, usage: cost, time: turns, share }) => ({
    key: id, label, search: label, share,
    amount: !cost ? "" : priced ? `${formatMoney(cost.cost)}  ${formatTokens(cost.tokens)} tok` : `${formatTokens(cost.tokens)} tok`,
    detail: [
      cost && `${formatCount(cost.messages)} msg`,
      turns && `${formatDuration(turns.agent)} agent  ${formatCount(turns.turns)} turns  ${formatDuration(turns.wait)} wait`,
    ].filter(Boolean).join("  "),
  }))
}

const turnEntry = (turn: LongTurn, open: () => void): Entry => ({
  key: `${turn.sessionID}:${turn.start}`, label: turn.title, amount: formatDuration(turn.duration),
  detail: `${turn.project}  ${turn.model}  ${formatStart(turn.start)}`, search: `${turn.title} ${turn.project} ${turn.model}`, open,
})

function EntryRow(props: { entry: Entry; selected: boolean }) {
  const tab = useTab()
  const palette = usePalette()
  const { shorten } = useText()
  const fg = (color: Color) => props.selected ? palette.selectedText : color
  const bar = () => props.entry.share === undefined ? 0 : BAR + 2
  return <>
    <box flexDirection="row" justifyContent="space-between" gap={1}>
      <text wrapMode="none" fg={fg(palette.text)}>
        {props.selected ? "> " : "  "}{shorten(props.entry.label, Math.max(4, tab.width() - props.entry.amount.length - 8))}
      </text>
      <text wrapMode="none" fg={fg(palette.value)}>{props.entry.amount}</text>
    </box>
    <text wrapMode="none" fg={fg(palette.muted)}>
      {"  "}<Show when={props.entry.share !== undefined}><Bar share={props.entry.share!} />{"  "}</Show>
      {shorten(props.entry.detail, Math.max(4, tab.width() - bar() - 6))}
    </text>
  </>
}

function Bar(props: { share: number }) {
  const palette = usePalette()
  const filled = () => props.share > 0 ? Math.min(BAR, Math.max(1, Math.round(props.share * BAR))) : 0
  return <><span style={{ fg: palette.accent }}>{"#".repeat(filled())}</span><span style={{ fg: palette.track }}>{"-".repeat(BAR - filled())}</span></>
}
