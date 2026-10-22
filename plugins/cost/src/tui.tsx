/** @jsxImportSource @opentui/solid */

import { errorMessage, formatCount, formatMoney } from "@opcode/core"
import { Card, CenterEmpty, FilterChip, KeyHints, Page, StatCard, usePalette, useText } from "@opcode/ui"
import { createScreen } from "@opcode/ui/screen"
import { Plugin } from "@opencode/plugin/tui"
import type { LocationRef } from "@opencode/client"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createComputed, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createCostService } from "./client.js"
import { DATE_RANGES, rangeLabel, type Breakdown, type Dashboard } from "./domain.js"
import { createImportRunner, importProject } from "./importer.js"
import { dashboardSections, MODE, parseRoute, PLUGIN_ID, ROUTE, type RouteState } from "./navigation.js"

interface ScreenProps {
  api: Plugin.Context
  state: () => RouteState
  setState: (state: RouteState) => void
  location: () => LocationRef
  params?: Record<string, unknown>
  revision: () => number
  importStatus: () => string
  mount: () => void
}

const backHint = { key: "esc", label: "back", command: "opcode-cost.close" }
const refreshHint = { key: "r", label: "refresh", command: "opcode-cost.refresh" }

function DashboardScreen(props: ScreenProps) {
  props.mount()
  const dimensions = useTerminalDimensions()
  const palette = usePalette()
  const { shorten } = useText()
  const [data, setData] = createSignal<Dashboard>()
  const [error, setError] = createSignal("")
  const [refreshWarning, setRefreshWarning] = createSignal("")
  const [tick, setTick] = createSignal(0)
  const sections = createMemo(() => dashboardSections(props.state()))
  createEffect(() => props.setState(parseRoute(props.params)))
  const query = createMemo(() => {
    const state = props.state()
    const location = props.location()
    return {
      key: JSON.stringify([state.range, state.projectID ?? null, state.model ?? null, location.directory, location.workspaceID ?? null]),
      filter: { range: state.range, projectID: state.projectID, model: state.model },
      location: { directory: location.directory, workspaceID: location.workspaceID },
    }
  }, undefined, { equals: (previous, next) => previous.key === next.key })
  type Query = ReturnType<typeof query> & { controller: AbortController; pending: boolean; queued: boolean }
  let current: Query | undefined
  const refresh = (request: Query) => {
    if (request !== current || request.controller.signal.aborted) return
    if (request.pending) {
      // Keep the in-flight read alive under streaming bursts; at most one follow-up is needed.
      request.queued = true
      return
    }
    request.pending = true
    void (async () => {
      try {
        const dashboard = await createCostService(props.api.client, request.location).dashboard(request.filter, request.controller.signal)
        if (request !== current || request.controller.signal.aborted) return
        batch(() => { setData(dashboard); setError(""); setRefreshWarning("") })
      } catch (cause) {
        if (request !== current || request.controller.signal.aborted) return
        if (data()) setRefreshWarning(errorMessage(cause))
        else setError(errorMessage(cause))
      } finally {
        request.pending = false
        if (request === current && !request.controller.signal.aborted && request.queued) {
          request.queued = false
          refresh(request)
        }
      }
    })()
  }
  createEffect(on(() => [query(), props.revision(), tick()] as const, ([next]) => {
    if (current?.key !== next.key) {
      current?.controller.abort()
      current = { ...next, controller: new AbortController(), pending: false, queued: false }
      // Clear stale values only for a different filter/location, not a background refresh.
      batch(() => { setData(undefined); setError(""); setRefreshWarning("") })
    }
    refresh(current)
  }))
  const timer = setInterval(() => setTick((value) => value + 1), 5_000)
  let pending: ReturnType<typeof setTimeout> | undefined
  const off = props.api.data.on("session.usage.updated", () => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => setTick((value) => value + 1), 100)
  })
  onCleanup(() => {
    current?.controller.abort()
    current = undefined
    clearInterval(timer)
    if (pending) clearTimeout(pending)
    off()
  })
  const projectLabel = () => {
    const id = props.state().projectID
    return id ? data()?.projectOptions.find((option) => option.id === id)?.label ?? id : "all projects"
  }
  const wide = () => dimensions().width >= 100
  const panelWidth = () => Math.floor((dimensions().width - 6) / (wide() ? 1 + Number(sections().models) + Number(sections().projects) : 1))
  const hints = () => wide() ? [
    backHint, { key: "d", label: "date", command: "opcode-cost.date" }, { key: "p", label: "project", command: "opcode-cost.project" },
    { key: "m", label: "model", command: "opcode-cost.model" }, { key: "x", label: "reset", command: "opcode-cost.reset" }, refreshHint,
  ] : [backHint, { key: "d/p/m", label: "filters" }, refreshHint, { key: "↑/↓", label: "scroll" }]
  return (
    <box width="100%" height="100%" minHeight={0} flexDirection="column">
      <Page
        title="Cost ledger"
        subtitle={wide() ? "all recorded OpenCode sessions" : "connected server"}
        actions={<KeyHints items={hints()} />}
        filters={(
          <box width="100%" flexDirection="row" flexWrap="wrap" gap={1}>
            <FilterChip label="date" value={rangeLabel(props.state().range)} />
            <FilterChip label="project" value={shorten(projectLabel(), wide() ? 30 : 18)} />
            <FilterChip label="model" value={shorten(props.state().model ?? "all models", wide() ? 40 : 24)} />
          </box>
        )}
        footer={(
          <box width="100%" flexDirection="row" justifyContent="space-between" gap={1}>
            <text fg={refreshWarning() ? palette.warning : palette.muted}>
              {refreshWarning()
                ? shorten(`Refresh failed: ${refreshWarning()}; showing last loaded usage.`, Math.max(12, dimensions().width - formatMoney(data()?.total.cost ?? 0).length - 6))
                : wide() ? "Provider-reported USD; no pricing is recalculated." : "Provider-reported USD; no recalculation."}
            </text>
            <text fg={palette.value}>{formatMoney(data()?.total.cost ?? 0)}</text>
          </box>
        )}
      >
        <scrollbox id="opcode-cost.content" flexGrow={1} minHeight={0} focused>
          <box flexDirection="column" flexGrow={1} flexShrink={0} gap={1}>
            <Show when={props.importStatus().includes("failed")}>
              <text fg={palette.warning}>{props.importStatus()}</text>
            </Show>
            <Show when={error()}>
              <Card grow minHeight={8}><CenterEmpty title="Unable to read ledger" description={error()} /></Card>
            </Show>
            <Show when={data()} fallback={<Show when={!error()}><Card grow minHeight={8}><CenterEmpty title="Loading server ledger…" /></Card></Show>}>
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
                      <Show when={sections().models}><BreakdownPanel title="BY MODEL" rows={dashboard().models} width={panelWidth()} /></Show>
                      <Show when={sections().projects}><BreakdownPanel title="BY PROJECT" rows={dashboard().projects} width={panelWidth()} /></Show>
                      <TrendPanel rows={dashboard().daily} width={panelWidth()} />
                    </box>
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

function BreakdownPanel(props: { title: string; rows: Breakdown[]; width: number }) {
  const palette = usePalette()
  const { shorten } = useText()
  const max = () => Math.max(0, ...props.rows.map((row) => row.cost))
  const width = () => Math.min(20, Math.max(4, props.width - 26))
  return (
    <Card title={props.title} grow minHeight={8}>
      <box flexDirection="column">
        <For each={props.rows}>{(row) => (
          <box flexDirection="column" paddingBottom={1} flexShrink={0}>
            <box flexDirection="row" justifyContent="space-between" gap={1}>
              <text fg={palette.text}>{shorten(row.label, Math.max(4, props.width - formatMoney(row.cost).length - 6))}</text>
              <text fg={palette.value}>{formatMoney(row.cost)}</text>
            </box>
            <text fg={palette.muted}><CostBar value={row.cost} max={max()} width={width()} />  {formatCount(row.messages)} msg  {formatTokens(row.tokens)} tok</text>
          </box>
        )}</For>
      </box>
    </Card>
  )
}

function TrendPanel(props: { rows: Breakdown[]; width: number }) {
  const palette = usePalette()
  const max = () => Math.max(0, ...props.rows.map((row) => row.cost))
  return (
    <Card title="DAILY ACTIVITY" grow minHeight={8}>
      <box flexDirection="column">
        <For each={props.rows}>{(row) => (
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text fg={palette.muted}>{row.label}</text>
            <text><CostBar value={row.cost} max={max()} width={Math.min(12, Math.max(4, props.width - 24))} /></text>
            <text fg={palette.value}>{formatMoney(row.cost)}</text>
          </box>
        )}</For>
      </box>
    </Card>
  )
}

function CostBar(props: { value: number; max: number; width: number }) {
  const palette = usePalette()
  const filled = () => props.value > 0 && props.max > 0 ? Math.min(props.width, Math.max(1, Math.round(props.value / props.max * props.width))) : 0
  return <><span style={{ fg: palette.accent }}>{"#".repeat(filled())}</span><span style={{ fg: palette.track }}>{"-".repeat(props.width - filled())}</span></>
}

function formatTokens(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(api) {
    const screen = createScreen(api, { id: PLUGIN_ID, name: ROUTE, mode: MODE })
    const controller = new AbortController()
    const [state, setState] = createSignal<RouteState>(parseRoute())
    const [revision, setRevision] = createSignal(0)
    const [importStatus, setImportStatus] = createSignal("History has not been reconciled yet.")
    const location = () => api.location ?? api.data.location.default()
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
      return [screen.active(), params?.range, params?.projectID, params?.model, JSON.stringify(location())]
    }, cancelSelection, { defer: true }))
    const tasks = new Set<Promise<void>>()
    const runImport = createImportRunner<LocationRef>((target) => JSON.stringify(target), async (target) => {
      if (controller.signal.aborted) return
      setImportStatus("Reconciling this project's history, including other worktrees…")
      try {
        await importProject(api.client, createCostService(api.client, target), controller.signal)
        if (!controller.signal.aborted) setImportStatus("History reconciled. Refresh retries and includes newly missed messages.")
      } catch (error) {
        if (!controller.signal.aborted) setImportStatus(`History import failed: ${errorMessage(error)}. Press r to retry.`)
      } finally {
        if (!controller.signal.aborted) setRevision((value) => value + 1)
      }
    })
    const reconcile = () => {
      const task = runImport(location())
      tasks.add(task)
      void task.finally(() => tasks.delete(task))
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
      setState(next)
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
      render: (input) => <DashboardScreen api={api} params={input.data} state={state} setState={setState} location={location} revision={revision} importStatus={importStatus} mount={mount} />,
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
          setState(parseRoute())
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
        { id: "opcode-cost.reset", title: "Reset cost filters", bind: "x", run() { update({ range: "30d" }) } },
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
