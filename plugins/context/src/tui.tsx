/** @jsxImportSource @opentui/solid */
import { errorMessage, formatCount } from "@opcode/core"
import { Card, CenterEmpty, cellWidth, KeyHints, shorten, StatCard } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { writeSnapshot } from "./export"
import { loadSnapshot } from "./load"
import { createSnapshotRefresh, type RefreshState } from "./refresh"
import type { Snapshot } from "./snapshot"
import { listWindow, percent } from "./view"

const tabs = ["Overview", "Content", "Environment"] as const

export function currentSessionID(context: Pick<Context, "ui">) {
  const route = context.ui.router.current()
  return route.type === "session" ? route.sessionID : undefined
}

export function ContextDialog(props: { sessionID?: string }) {
  const context = usePlugin()
  const dimensions = useTerminalDimensions()
  const colors = createMemo(() => context.theme.surface("dialog"))
  const [width, setWidth] = createSignal(dimensions().width)
  const [listSize, setListSize] = createSignal({ width: 0, height: 1 })
  const truncate = (text: string, cells: number) => shorten(text, cells, context.renderer.widthMethod)
  const detailBudget = () => Math.min(24, Math.max(0, Math.floor((listSize().width - 3) / 3)))
  const detailWidth = (text: string) => Math.min(cellWidth(text, context.renderer.widthMethod), detailBudget())
  const [tab, setTab] = createSignal(0)
  const [selection, setSelection] = createSignal(0)
  const [state, setState] = createSignal<RefreshState>({ loading: true })
  let overview: ScrollBoxRenderable | undefined
  const refresh = createSnapshotRefresh((signal) => loadSnapshot(context, props.sessionID, signal), setState)
  const bodyHeight = () => Math.max(4, Math.min(28, dimensions().height - 10
    - Number(Boolean(state().error)) - Number(Boolean(state().snapshot?.warnings.length))))
  const snapshot = () => state().snapshot
  const rows = createMemo(() => tab() === 1
    ? snapshot()?.retained?.contributors.map((row) => ({ id: row.id, label: row.label, detail: `~${formatCount(row.estimatedTokens)} tok` })) ?? []
    : tab() === 2 ? snapshot()?.environment.map((row) => ({ id: `${row.category}:${row.name}`, label: `${row.category}: ${row.name}`, detail: row.detail ?? "configured" })) ?? [] : [])
  const window = createMemo(() => listWindow(rows().length, selection(), listSize().height))
  const move = (by: number) => {
    if (tab() === 0) { overview?.scrollBy(by); return }
    setSelection(listWindow(rows().length, window().selected + by, listSize().height).selected)
  }
  const switchTab = (by: number) => { setTab((value) => (value + by + tabs.length) % tabs.length); setSelection(0) }
  const exportCurrent = async () => {
    const current = snapshot()
    if (!current || state().loading || state().error) {
      context.ui.toast.show({ variant: "warning", message: "Refresh successfully before exporting a context snapshot." })
      return
    }
    try {
      const path = await writeSnapshot(current)
      context.ui.toast.show({ variant: "success", title: "Context exported", message: path })
    } catch (error) {
      context.ui.toast.show({ variant: "error", title: "Export failed", message: errorMessage(error) })
    }
  }
  useDialogCommands(context, () => [
      { id: "opcode-context.close", bind: "escape", run: () => context.ui.dialog.clear() },
      { id: "opcode-context.next", bind: "right,l", run: () => switchTab(1) },
      { id: "opcode-context.previous", bind: "left,h", run: () => switchTab(-1) },
      { id: "opcode-context.down", bind: "down,j", run: () => move(1) },
      { id: "opcode-context.up", bind: "up,k", run: () => move(-1) },
      { id: "opcode-context.refresh", bind: "r", run: refresh.refresh },
      { id: "opcode-context.export", bind: "e", run: exportCurrent },
  ])
  const stop = context.data.listen(({ details }) => {
    if ("sessionID" in details.data && details.data.sessionID === props.sessionID) refresh.schedule()
  })
  onMount(() => void refresh.refresh())
  onCleanup(() => { refresh.dispose(); stop() })

  return (
    <box width="100%" maxWidth="100%" overflow="hidden" flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}
      backgroundColor={colors().background.base} onSizeChange={function () { setWidth(this.width) }}>
        <box flexDirection="row" justifyContent="space-between" gap={1} paddingBottom={1}>
          <text wrapMode="none" fg={colors().text.base}><b>Current context</b><span style={{ fg: colors().text.muted }}> {truncate(props.sessionID ?? "no active session", Math.max(0, width() - 31 - (state().loading ? 12 : 0)))}</span></text>
          <box flexDirection="row">
            <Show when={state().loading}><text fg={colors().text.muted}>refreshing  </text></Show>
            <KeyHints items={[{ key: "esc", label: "close", command: "opcode-context.close" }]} />
          </box>
        </box>
        <box flexDirection="row" gap={1} paddingBottom={1}>
          <For each={tabs}>{(name, index) => (
            <box border borderColor={index() === tab() ? colors().text.action.primary.base : colors().border.base}
              paddingLeft={width() >= 44 ? 1 : 0} paddingRight={width() >= 44 ? 1 : 0}
              onMouseDown={(event) => {
                if (event.button !== 0) return
                event.stopPropagation()
                switchTab(index() - tab())
              }}>
              <text fg={index() === tab() ? colors().text.action.primary.base : colors().text.muted}>{name}</text>
            </box>
          )}</For>
        </box>
        <Show when={state().error}><text wrapMode="none" fg={colors().text.feedback.error.base}>{truncate(`Refresh failed: ${state().error}; previous data is stale. r retry`, width() - 4)}</text></Show>
        <Show when={snapshot()?.warnings.length}>
          <text wrapMode="none" fg={colors().text.feedback.warning.base}>{truncate(`Degraded (${snapshot()!.warnings.length}): ${snapshot()!.warnings[0]}`, width() - 4)}</text>
        </Show>
        <box height={bodyHeight()} flexDirection="column" overflow="hidden">
          <Show when={props.sessionID} fallback={<Card compact grow><CenterEmpty title="No active session" description="Open a session, then run /context again." /></Card>}>
            <Show when={snapshot()} fallback={<Card compact grow><CenterEmpty title={state().error ? "Context could not be loaded" : "Loading context…"} /></Card>}>
              <Show when={tab() === 0} fallback={
                <Card title={truncate(`${tab() === 1 ? "LARGEST RETAINED CONTRIBUTORS" : "OBSERVABLE ENVIRONMENT"}  ${rows().length}`, width() - 8)} compact grow>
                  <box flexGrow={1} minHeight={0} overflow="hidden" flexDirection="column" onSizeChange={function () { setListSize({ width: this.width, height: this.height }) }}>
                  <Show when={rows().length} fallback={<CenterEmpty title={tab() === 1 && !snapshot()?.retained ? "Retained context unavailable" : "No observable entries"}
                    description={tab() === 1 && !snapshot()?.retained ? "History is not a retained estimate." : undefined} />}>
                    <For each={rows().slice(window().start, window().end)}>{(row, index) => (
                      <box flexDirection="row" height={1} flexShrink={0} justifyContent="space-between" gap={1}
                        backgroundColor={window().start + index() === window().selected ? colors().background.raised.base : undefined}>
                        <text wrapMode="none" fg={window().start + index() === window().selected ? colors().text.action.primary.base : colors().text.base}>
                          {window().start + index() === window().selected ? "> " : "  "}{truncate(row.label, Math.max(0, listSize().width - 3 - detailWidth(row.detail)))}
                        </text>
                        <text wrapMode="none" fg={colors().text.muted}>{truncate(row.detail, detailBudget())}</text>
                      </box>
                    )}</For>
                  </Show>
                  </box>
                </Card>
              }>
                <scrollbox ref={overview} height={bodyHeight()}><Overview snapshot={snapshot()!} width={width() - 4} /></scrollbox>
              </Show>
            </Show>
          </Show>
        </box>
        <box paddingTop={1}><KeyHints items={[
          { key: "h/l", label: "tabs", command: "opcode-context.next" },
          { key: "j/k", label: "rows", command: "opcode-context.down" },
          { key: "r", label: "refresh", command: "opcode-context.refresh" },
          { key: "e", label: "export", command: "opcode-context.export" },
        ]} /></box>
    </box>
  )
}

function Overview(props: { snapshot: Snapshot; width: number }) {
  const context = usePlugin()
  const colors = createMemo(() => context.theme.surface("dialog"))
  const snapshot = () => props.snapshot
  const tokens = (value: number) => snapshot().usageReports ? formatCount(value) : "unavailable"
  const narrow = () => props.width < 60
  const truncate = (text: string, width = props.width - 4) => shorten(text, Math.max(0, width), context.renderer.widthMethod)
  const model = () => snapshot().model
  const cardWidth = () => narrow() ? props.width : Math.floor((props.width - 1) / 2)
  return (
    <box flexDirection="column" gap={1}>
      <Card compact>
        <text wrapMode="none" fg={colors().text.base}><b>{truncate(model() ? `${model()!.providerName ?? model()!.providerID}/${model()!.modelName ?? model()!.modelID}` : "Model unavailable")}</b></text>
        <text fg={colors().text.muted}>Context limit <span style={{ fg: colors().text.base }}>{model()?.contextLimit ? formatCount(model()!.contextLimit!) : "unavailable"}</span> · Estimated utilization <span style={{ fg: colors().text.feedback.warning.base }}>{percent(snapshot().utilization)}</span></text>
      </Card>
      <box flexDirection={narrow() ? "column" : "row"} gap={1}>
        <box width={cardWidth()}><StatCard compact label="RECORDED INPUT" value={tokens(snapshot().usage.input + snapshot().usage.cacheRead + snapshot().usage.cacheWrite)} detail={`${tokens(snapshot().usage.input)} fresh`} /></box>
        <box width={cardWidth()}><StatCard compact label="CACHE" value={tokens(snapshot().usage.cacheRead + snapshot().usage.cacheWrite)} detail={`${percent(snapshot().cacheEfficiency)} read efficiency`} /></box>
      </box>
      <box flexDirection={narrow() ? "column" : "row"} gap={1}>
        <box width={cardWidth()}><StatCard compact label="OUTPUT" value={tokens(snapshot().usage.output)} detail={`${tokens(snapshot().usage.reasoning)} reasoning`} /></box>
        <box width={cardWidth()}><StatCard compact label="RETAINED EST." value={snapshot().retained ? formatCount(snapshot().retained!.estimatedTokens) : "unavailable"}
          detail={snapshot().retained ? `${formatCount(snapshot().retained!.characters)} chars` : "Retained context unavailable"} /></box>
      </box>
      <Card compact title="ACTIVITY">
        <text fg={colors().text.muted}>Messages: <span style={{ fg: colors().text.base }}>{snapshot().messageCount.user} user / {snapshot().messageCount.assistant} assistant</span></text>
        <text fg={colors().text.muted}>Tools / compactions: <span style={{ fg: colors().text.base }}>{snapshot().toolCalls} / {snapshot().compaction.count}</span></text>
        <text wrapMode="none" fg={colors().text.muted}>{truncate(`Latest checkpoint: ${snapshot().compaction.latestBoundary ?? "unavailable"}`)}</text>
        <text fg={colors().text.muted}>History: <span style={{ fg: colors().text.base }}>{snapshot().history}</span> · Retained: <span style={{ fg: colors().text.base }}>{snapshot().retained ? "estimated" : "unavailable"}</span></text>
      </Card>
      <text fg={colors().text.muted}>Provider tokens are <span style={{ fg: colors().text.feedback.success.base }}>recorded</span>; retained size and utilization are <span style={{ fg: colors().text.feedback.warning.base }}>estimated</span>.</text>
      <text fg={colors().text.muted}>Excludes hidden instructions, tool schemas &amp; attachment payloads.</text>
      <For each={snapshot().warnings}>{(warning) => <text wrapMode="none" fg={colors().text.feedback.warning.base}>{truncate(warning)}</text>}</For>
    </box>
  )
}

export default Plugin.define({
  id: "opcode-context",
  setup(context) {
    let opened = false
    context.keymap.layer(() => ({ mode: "global", commands: [{
      id: "opcode-context.open", title: "Context", group: "Opcode", palette: true,
      description: "Inspect current-session context usage", slash: { name: "context" },
      run() {
        const sessionID = currentSessionID(context)
        context.ui.dialog.show(() => <ContextDialog sessionID={sessionID} />, () => { opened = false })
        opened = true
        context.ui.dialog.set({ size: "large", centered: true })
      },
    }] }))
    return () => { if (opened) context.ui.dialog.clear() }
  },
})
