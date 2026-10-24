/** @jsxImportSource @opentui/solid */

import { errorMessage, formatCount, formatMoney } from "@opcode/core"
import { Card, CenterEmpty, FilterChip, KeyHints, Page, StatCard, usePalette, useText } from "@opcode/ui"
import { createScreen } from "@opcode/ui/screen"
import { createRefresh, type RefreshState, type SetTimer } from "@opcode/core/refresh"
import { Plugin } from "@opencode/plugin/tui"
import type { LocationRef } from "@opencode/client"
import { useTerminalDimensions } from "@opentui/solid"
import { createComputed, createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from "solid-js"
import { createCostService } from "./client.js"
import { DATE_RANGES, localDay, rangeLabel, type Breakdown, type Dashboard, type LongTurn, type TimeBreakdown, type TimeDashboard } from "./domain.js"
import { importProject } from "./importer.js"
import { dashboardSections, MODE, parseRoute, PLUGIN_ID, ROUTE, TABS, type RouteState } from "./navigation.js"

/** Injectable so tests drive refreshes without real timers. Each returns its cancel function. */
export interface Timers {
  interval(run: () => void): () => void
  /** One-shot debounce and timeout timers for dashboard reads. */
  timer: SetTimer
}

const timers: Timers = {
  interval: (run) => { const id = setInterval(run, 5_000); return () => clearInterval(id) },
  timer: (run, ms) => { const id = setTimeout(run, ms); return () => clearTimeout(id) },
}

type ImportState = { type: "idle" } | { type: "running" } | { type: "failed"; message: string }

interface ScreenProps {
  api: Plugin.Context
  timers: Timers
  location: () => LocationRef
  params?: Record<string, unknown>
  revision: () => number
  importState: () => ImportState
  mount: () => void
}

const backHint = { key: "esc", label: "back", command: "opcode-cost.close" }
const refreshHint = { key: "r", label: "refresh", command: "opcode-cost.refresh" }

/** Values are tagged by tab, so a render between a tab switch and its reset never reads the other tab's shape. */
type Loaded = { tab: "cost"; cost: Dashboard } | { tab: "time"; time: TimeDashboard }

function DashboardScreen(props: ScreenProps) {
  props.mount()
  const dimensions = useTerminalDimensions()
  const palette = usePalette()
  const { shorten } = useText()
  const [read, setRead] = createSignal<RefreshState<Loaded>>({ loading: true })
  const cost = () => { const value = read().value; return value?.tab === "cost" ? value.cost : undefined }
  const time = () => { const value = read().value; return value?.tab === "time" ? value.time : undefined }
  // A failure with loaded data is a stale-data warning; without it, the dashboard has nothing honest to show.
  const error = () => read().value ? "" : read().error ?? ""
  const refreshWarning = () => read().value ? read().error ?? "" : ""
  const state = createMemo(() => parseRoute(props.params))
  const sections = createMemo(() => dashboardSections(state()))
  const query = createMemo(() => {
    const filter = state()
    const location = props.location()
    return {
      key: JSON.stringify([filter.tab, filter.range, filter.projectID ?? null, filter.model ?? null, location.directory, location.workspaceID ?? null]),
      tab: filter.tab,
      filter: { range: filter.range, projectID: filter.projectID, model: filter.model },
      location: { directory: location.directory, workspaceID: location.workspaceID },
    }
  }, undefined, { equals: (previous, next) => previous.key === next.key })
  // Polls, usage events, and import revisions coalesce behind the in-flight read.
  const refresh = createRefresh(async (signal): Promise<Loaded> => {
    const { tab, filter, location } = untrack(query)
    const service = createCostService(props.api.client, location)
    return tab === "time" ? { tab, time: await service.time(filter, signal) } : { tab, cost: await service.dashboard(filter, signal) }
  }, setRead, { delay: 100, timer: props.timers.timer })
  createEffect(on(query, () => {
    // Drop stale values only for a different tab/filter/location, not a background refresh.
    refresh.reset()
    void refresh.refresh()
  }))
  createEffect(on(props.revision, () => refresh.schedule(), { defer: true }))
  onCleanup(() => refresh.dispose())
  onCleanup(props.timers.interval(() => refresh.schedule()))
  onCleanup(props.api.data.on("session.usage.updated", () => refresh.schedule()))
  const importFailure = () => {
    const current = props.importState()
    return current.type === "failed" ? current.message : undefined
  }
  const projectLabel = () => {
    const id = state().projectID
    return id ? cost()?.projectOptions.find((option) => option.id === id)?.label ?? time()?.projects.find((row) => row.id === id)?.label ?? id : "all projects"
  }
  const wide = () => dimensions().width >= 100
  const panelWidth = () => Math.floor((dimensions().width - 6) / (wide() ? 1 + Number(sections().models) + Number(sections().projects) : 1))
  const [selected, setSelected] = createSignal(0)
  const longest = () => time()?.longest ?? []
  const current = () => Math.max(0, Math.min(selected(), longest().length - 1))
  const openTurn = (turn: LongTurn | undefined) => {
    if (!turn) return
    // Like Sessions: the terminal opens only sessions of its own location.
    if (turn.directory === props.location().directory) props.api.ui.router.navigate({ type: "session", sessionID: turn.sessionID })
    else props.api.ui.toast.show({ variant: "info", message: `Open OpenCode in ${turn.directory} to resume this session.` })
  }
  props.api.keymap.layer(() => ({
    mode: MODE,
    enabled: () => state().tab === "time",
    commands: [
      { id: "opcode-cost.turn.next", title: "Select next turn", bind: "j", run: () => setSelected(Math.min(current() + 1, longest().length - 1)) },
      { id: "opcode-cost.turn.previous", title: "Select previous turn", bind: "k", run: () => setSelected(Math.max(current() - 1, 0)) },
      { id: "opcode-cost.turn.open", title: "Open turn session", bind: "enter,return", run: () => openTurn(longest()[current()]) },
    ],
  }))
  const tabHint = () => ({ key: "tab", label: state().tab === "cost" ? "time" : "cost", command: "opcode-cost.tab" })
  const turnHint = { key: "j/k enter", label: "open turn", command: "opcode-cost.turn.open" }
  const hints = () => [
    ...wide() ? [
      backHint, tabHint(), { key: "d", label: "date", command: "opcode-cost.date" }, { key: "p", label: "project", command: "opcode-cost.project" },
      { key: "m", label: "model", command: "opcode-cost.model" }, { key: "x", label: "reset", command: "opcode-cost.reset" }, refreshHint,
    ] : [backHint, tabHint(), { key: "d/p/m", label: "filters" }, refreshHint, { key: "↑/↓", label: "scroll" }],
    ...state().tab === "time" ? [turnHint] : [],
  ]
  const footer = () => {
    if (refreshWarning()) return `Refresh failed: ${refreshWarning()}; showing last loaded usage.`
    if (state().tab === "time") return wide() ? "Root sessions only; subagent work counts in its parent's turn." : "Root sessions only."
    return wide() ? "Provider-reported USD; no pricing is recalculated." : "Provider-reported USD; no recalculation."
  }
  const total = () => state().tab === "time" ? formatDuration(time()?.total.agent ?? 0) : formatMoney(cost()?.total.cost ?? 0)
  return (
    <box width="100%" height="100%" minHeight={0} flexDirection="column">
      <Page
        title="Cost ledger"
        subtitle={wide() ? "all recorded OpenCode sessions" : "connected server"}
        actions={<KeyHints items={hints()} />}
        filters={(
          <box width="100%" flexDirection="row" flexWrap="wrap" gap={1}>
            <For each={TABS}>{(tab) => (
              <box border borderColor={tab === state().tab ? palette.value : palette.border} paddingX={1} height={3}
                onMouseDown={(event) => {
                  if (event.button !== 0) return
                  event.stopPropagation()
                  if (tab !== state().tab) props.api.keymap.dispatch("opcode-cost.tab")
                }}>
                <text fg={tab === state().tab ? palette.value : palette.muted}>{tab === "cost" ? "Cost" : "Time"}</text>
              </box>
            )}</For>
            <FilterChip label="date" value={rangeLabel(state().range)} />
            <FilterChip label="project" value={shorten(projectLabel(), wide() ? 30 : 18)} />
            <FilterChip label="model" value={shorten(state().model ?? "all models", wide() ? 40 : 24)} />
          </box>
        )}
        footer={(
          <box width="100%" flexDirection="row" justifyContent="space-between" gap={1}>
            <text fg={refreshWarning() ? palette.warning : palette.muted}>{shorten(footer(), Math.max(12, dimensions().width - total().length - 6))}</text>
            <text fg={palette.value}>{total()}</text>
          </box>
        )}
      >
        <scrollbox id="opcode-cost.content" flexGrow={1} minHeight={0} focused>
          <box flexDirection="column" flexGrow={1} flexShrink={0} gap={1}>
            <Show when={importFailure()}>
              {(message) => <text fg={palette.warning}>{`History import failed: ${message()}. Press r to retry.`}</text>}
            </Show>
            <Show when={error()}>
              <Card grow minHeight={8}><CenterEmpty title="Unable to read ledger" description={error()} /></Card>
            </Show>
            <Show when={!read().value && !error()}><Card grow minHeight={8}><CenterEmpty title="Loading server ledger…" /></Card></Show>
            <Show when={cost()}>
              {(dashboard) => (
                <>
                  <box id="opcode-cost.totals" flexDirection="row" gap={1} flexShrink={0}>
                    <StatCard label="TOTAL COST" value={formatMoney(dashboard().total.cost)} detail={`${formatCount(dashboard().total.messages)} recorded messages`} />
                    <StatCard label="ALL TOKENS" value={formatTokens(dashboard().total.tokens)} detail={`${formatTokens(dashboard().total.input)} input`} />
                    <Show when={wide()}>
                      <StatCard label="OUTPUT" value={formatTokens(dashboard().total.output)} detail={`${formatTokens(dashboard().total.reasoning)} reasoning`} />
                      <StatCard label="CACHE" value={formatTokens(dashboard().total.cacheRead + dashboard().total.cacheWrite)} detail={`${formatTokens(dashboard().total.cacheRead)} read`} />
                    </Show>
                  </box>
                  <Show when={dashboard().total.messages > 0} fallback={(
                    <Card grow minHeight={8}>
                      <CenterEmpty title="No recorded usage" description="Press r to reconcile this project's history, or change the filters." />
                    </Card>
                  )}>
                    <box flexGrow={1} flexDirection={wide() ? "row" : "column"} gap={1}>
                      <Show when={sections().models}><BreakdownPanel title="BY MODEL" rows={dashboard().models.map(costRow)} width={panelWidth()} /></Show>
                      <Show when={sections().projects}><BreakdownPanel title="BY PROJECT" rows={dashboard().projects.map(costRow)} width={panelWidth()} /></Show>
                      <TrendPanel rows={dashboard().daily.map(costRow)} width={panelWidth()} />
                    </box>
                  </Show>
                </>
              )}
            </Show>
            <Show when={time()}>
              {(view) => (
                <>
                  <box id="opcode-cost.totals" flexDirection="row" gap={1} flexShrink={0}>
                    <StatCard label="AGENT TIME" value={formatDuration(view().total.agent)} detail={`${formatCount(view().total.turns)} turns`} />
                    <StatCard label="WAITING ON YOU" value={formatDuration(view().total.wait)} detail="at most 30m per wait" />
                    <Show when={wide()}>
                      <StatCard label="PARALLEL" value={formatDuration(view().total.parallel)} detail={`peak ${formatCount(view().total.peak)} sessions`} />
                    </Show>
                  </box>
                  <Show when={view().total.turns > 0} fallback={(
                    <Card grow minHeight={8}>
                      <CenterEmpty title="No recorded turns" description="Press r to reconcile this project's history, or change the filters." />
                    </Card>
                  )}>
                    <box flexDirection={wide() ? "row" : "column"} gap={1} flexShrink={0}>
                      <Show when={sections().models}><BreakdownPanel title="BY MODEL" rows={view().models.map(timeRow)} width={panelWidth()} /></Show>
                      <Show when={sections().projects}><BreakdownPanel title="BY PROJECT" rows={view().projects.map(timeRow)} width={panelWidth()} /></Show>
                      <TrendPanel rows={view().daily.map(timeRow)} width={panelWidth()} />
                    </box>
                    <LongestPanel rows={view().longest} selected={current()} width={dimensions().width - 6} open={(index) => { setSelected(index); openTurn(longest()[index]) }} />
                  </Show>
                </>
              )}
            </Show>
          </box>
        </scrollbox>
      </Page>
    </box>
  )
}

/** One bar-chart row: `value` sizes the bar, `amount` labels it. */
interface BarRow { id: string; label: string; value: number; amount: string; detail: string }

const costRow = (row: Breakdown): BarRow => ({
  id: row.id, label: row.label, value: row.cost, amount: formatMoney(row.cost),
  detail: `${formatCount(row.messages)} msg  ${formatTokens(row.tokens)} tok`,
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
    <Card title={props.title} grow minHeight={8}>
      <box flexDirection="column">
        <For each={props.rows}>{(row) => (
          <box flexDirection="column" paddingBottom={1} flexShrink={0}>
            <box flexDirection="row" justifyContent="space-between" gap={1}>
              <text fg={palette.text}>{shorten(row.label, Math.max(4, props.width - row.amount.length - 6))}</text>
              <text fg={palette.value}>{row.amount}</text>
            </box>
            <text fg={palette.muted}><Bar value={row.value} max={max()} width={width()} />  {row.detail}</text>
          </box>
        )}</For>
      </box>
    </Card>
  )
}

function TrendPanel(props: { rows: BarRow[]; width: number }) {
  const palette = usePalette()
  const max = () => Math.max(0, ...props.rows.map((row) => row.value))
  return (
    <Card title="DAILY ACTIVITY" grow minHeight={8}>
      <box flexDirection="column">
        <For each={props.rows}>{(row) => (
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text fg={palette.muted}>{row.label}</text>
            <text><Bar value={row.value} max={max()} width={Math.min(12, Math.max(4, props.width - 24))} /></text>
            <text fg={palette.value}>{row.amount}</text>
          </box>
        )}</For>
      </box>
    </Card>
  )
}

function LongestPanel(props: { rows: LongTurn[]; selected: number; width: number; open: (index: number) => void }) {
  const palette = usePalette()
  const { shorten } = useText()
  return (
    <Card title="LONGEST TURNS" minHeight={8}>
      <box flexDirection="column">
        <For each={props.rows}>{(row, index) => {
          const active = () => index() === props.selected
          const amount = () => formatDuration(row.duration)
          return (
            <box flexDirection="column" flexShrink={0} backgroundColor={active() ? palette.selectedBackground : undefined}
              onMouseDown={(event) => {
                if (event.button !== 0) return
                event.stopPropagation()
                props.open(index())
              }}>
              <box flexDirection="row" justifyContent="space-between" gap={1}>
                <text wrapMode="none" fg={active() ? palette.selectedText : palette.text}>
                  {active() ? "> " : "  "}{shorten(row.title, Math.max(4, props.width - amount().length - 8))}
                </text>
                <text wrapMode="none" fg={active() ? palette.selectedText : palette.value}>{amount()}</text>
              </box>
              <text wrapMode="none" fg={active() ? palette.selectedText : palette.muted}>
                {"  "}{shorten(`${row.project}  ${row.model}  ${formatStart(row.start)}`, Math.max(4, props.width - 6))}
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

function formatTokens(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)
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

export const createCostTui = (timing: Timers = timers) => Plugin.define({
  id: PLUGIN_ID,
  setup(api) {
    const screen = createScreen(api, { id: PLUGIN_ID, name: ROUTE, mode: MODE })
    const controller = new AbortController()
    const [revision, setRevision] = createSignal(0)
    const [imports, setImports] = createSignal<Record<string, ImportState>>({})
    const location = () => api.location ?? api.data.location.default()
    // Each location keeps its own import state; the dashboard only shows the current location's.
    const importState = () => imports()[JSON.stringify(location())] ?? { type: "idle" }
    let selectionController: AbortController | undefined
    const cancelSelection = () => {
      selectionController?.abort()
      selectionController = undefined
    }
    // The shared screen invalidates interactions. Cost additionally aborts actual RPC work
    // when the host changes location/filters or navigates away, including store-backed routes.
    createComputed(on(() => {
      const route = api.ui.router.current()
      const params = screen.owns(route) && route.type === "plugin" ? route.data : undefined
      return [screen.active(), params?.tab, params?.range, params?.projectID, params?.model, JSON.stringify(location())]
    }, cancelSelection, { defer: true }))
    const tasks = new Set<Promise<void>>()
    let importing: { key: string; abort: AbortController; task: Promise<void> } | undefined
    /** One import at a time: a repeat for the same location joins it; another location cancels it. */
    const reconcile = () => {
      if (controller.signal.aborted) return Promise.resolve()
      const target = { ...location() }
      const key = JSON.stringify(target)
      if (importing?.key === key) return importing.task
      importing?.abort.abort()
      const abort = new AbortController()
      const signal = AbortSignal.any([controller.signal, abort.signal])
      const settle = (state: ImportState) => { if (!signal.aborted) setImports((all) => ({ ...all, [key]: state })) }
      settle({ type: "running" })
      const task: Promise<void> = importProject(api.client, createCostService(api.client, target), signal).then(
        () => settle({ type: "idle" }),
        (error: unknown) => settle({ type: "failed", message: errorMessage(error) }),
      ).finally(() => {
        tasks.delete(task)
        if (importing?.task === task) importing = undefined
        if (!signal.aborted) setRevision((value) => value + 1)
      })
      importing = { key, abort, task }
      tasks.add(task)
      return task
    }
    void reconcile()
    createEffect(on(location, () => { void reconcile() }, { defer: true }))
    const currentState = () => {
      const route = api.ui.router.current()
      return parseRoute(screen.owns(route) && route.type === "plugin" ? route.data : undefined)
    }
    const update = (next: RouteState) => {
      if (controller.signal.aborted || !screen.active()) return
      cancelSelection()
      api.ui.dialog.clear()
      screen.update({ ...next })
    }
    const beginSelection = () => {
      if (controller.signal.aborted || !screen.active()) return
      cancelSelection()
      const current = screen.interaction()
      const previous = currentState()
      const target = { ...location() }
      const locationKey = JSON.stringify(target)
      const filterKey = (state: RouteState) => JSON.stringify([state.range, state.projectID, state.model])
      const previousKey = filterKey(previous)
      const abort = new AbortController()
      selectionController = abort
      return {
        previous, target, signal: AbortSignal.any([controller.signal, abort.signal]),
        valid: () => current() && !controller.signal.aborted && !abort.signal.aborted
          && JSON.stringify(location()) === locationKey && filterKey(currentState()) === previousKey,
      }
    }
    const mount = () => {
      screen.mount()
      onCleanup(cancelSelection)
    }
    const unregister = api.ui.router.register({
      name: ROUTE,
      render: (input) => <DashboardScreen api={api} timers={timing} params={input.data} location={location} revision={revision} importState={importState} mount={mount} />,
    })
    api.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "opcode-cost.open", title: "Cost", description: "Open the server cost and token ledger", group: "Plugin", palette: true,
        slash: { name: "cost" },
        run() {
          if (controller.signal.aborted) return
          cancelSelection()
          api.ui.dialog.clear()
          screen.open({ range: "30d" })
        },
      }],
    }))
    screen.commands(() => [
        { id: "opcode-cost.close", title: "Close cost dashboard", bind: "escape", run() {
          if (controller.signal.aborted || !screen.active()) return
          cancelSelection()
          screen.close()
        } },
        { id: "opcode-cost.date", title: "Filter by date", bind: "d", async run() {
          const selection = beginSelection()
          if (!selection?.valid()) return
          const { previous } = selection
          const range = await api.ui.dialog.select({ title: "Date range", current: previous.range,
            options: DATE_RANGES.map((value) => ({ title: rangeLabel(value), value })) })
          if (selection.valid() && range !== undefined) update({ ...previous, range })
        } },
        { id: "opcode-cost.project", title: "Filter by project", bind: "p", async run() {
          const selection = beginSelection()
          if (!selection?.valid()) return
          const { previous } = selection
          try {
            const dashboard = await createCostService(api.client, selection.target).dashboard(previous, selection.signal)
            if (!selection.valid()) return
            const projectID = await api.ui.dialog.select({ title: "Project", current: previous.projectID ?? "", options: [
              { title: "All projects", value: "" },
              ...dashboard.projectOptions.map((item) => ({ title: item.label, value: item.id, description: item.directory })),
            ] })
            if (selection.valid() && projectID !== undefined) update({ ...previous, projectID: projectID || undefined })
          } catch (error) { if (selection.valid()) api.ui.toast.show({ message: errorMessage(error), variant: "error" }) }
        } },
        { id: "opcode-cost.model", title: "Filter by model", bind: "m", async run() {
          const selection = beginSelection()
          if (!selection?.valid()) return
          const { previous } = selection
          try {
            const dashboard = await createCostService(api.client, selection.target).dashboard(previous, selection.signal)
            if (!selection.valid()) return
            const model = await api.ui.dialog.select({ title: "Model", current: previous.model ?? "", options: [
              { title: "All models", value: "" }, ...dashboard.modelOptions.map((item) => ({ title: item.label, value: item.id })),
            ] })
            if (selection.valid() && model !== undefined) update({ ...previous, model: model || undefined })
          } catch (error) { if (selection.valid()) api.ui.toast.show({ message: errorMessage(error), variant: "error" }) }
        } },
        { id: "opcode-cost.reset", title: "Reset cost filters", bind: "x", run() { update({ range: "30d", tab: currentState().tab }) } },
        { id: "opcode-cost.tab", title: "Switch cost/time tab", bind: "tab,shift+tab", run() {
          const current = currentState()
          update({ ...current, tab: current.tab === "cost" ? "time" : "cost" })
        } },
        { id: "opcode-cost.refresh", title: "Reconcile history and refresh", bind: "r", async run() {
          if (controller.signal.aborted || !screen.active()) return
          setRevision((value) => value + 1)
          await reconcile()
        } },
    ])
    return async () => {
      controller.abort()
      cancelSelection()
      screen.dispose()
      unregister()
      await Promise.allSettled(tasks)
    }
  },
})

export default createCostTui()
