/** @jsxImportSource @opentui/solid */
import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Page, Card, FilterChip, KeyHints, CenterEmpty, usePalette, useText } from "@opcode/ui"
import { useInputScope, type Screen } from "@opcode/ui/screen"
import { formatCount, formatMoney } from "@opcode/core"
import { viewport } from "./domain"
import type { BrowserModel } from "./browser"

export const BROWSER_ROUTE = "opcode-sessions.browser"
export const BROWSER_MODE = "opcode-sessions.browser"
const projectName = (directory: string) => directory.split(/[\\/]/).filter(Boolean).at(-1) || directory
function updatedAge(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return days < 365 ? `${days}d` : `${Math.floor(days / 365)}y`
}

const searchHint = { key: "/", label: "search", command: "opcode-sessions.search" }
const projectHint = { key: "p", label: "project", command: "opcode-sessions.project" }
const backHint = { key: "esc", label: "back", command: "opcode-sessions.close" }

export function SessionsView(props: { model: BrowserModel; currentSession: () => string | undefined; screen?: Screen }) {
  const api = usePlugin()
  const palette = usePalette()
  const { shorten, cellWidth } = useText()
  const dimensions = useTerminalDimensions()
  const state = props.model.state
  const [start, setStart] = createSignal(0)
  const [listSize, setListSize] = createSignal({ width: Math.max(1, dimensions().width - 8), height: Math.max(1, dimensions().height - 13) })
  const [previewSize, setPreviewSize] = createSignal({ width: 36, height: 16 })
  const capacity = () => Math.max(1, listSize().height)
  const showPreview = () => dimensions().width >= 100 && dimensions().height >= 24
  const previewWidth = () => Math.max(38, Math.floor((dimensions().width - 4) * 0.34))
  const window = createMemo(() => viewport(state().selected, state().rows.length, capacity(), start()))
  createEffect(() => setStart(window().start))
  const selected = () => state().rows[window().selected]
  const project = () => state().projects.find((project) => project.id === state().projectID)?.label ?? "all projects"
  const selectedProject = () => shorten(projectName(selected()?.directory ?? ""), Math.min(18, Math.floor(dimensions().width * 0.25)))
  const footerWidth = () => Math.max(1, dimensions().width - 6 - cellWidth(selectedProject()))
  const sourceInfo = () => dimensions().width >= 100 ? "Search indexes session titles, project paths, and message text." : dimensions().width >= 70 ? "Session titles, paths, and message text." : "Server session index"
  const modelName = () => selected()?.providerID && selected()?.modelID ? `${selected()!.providerID}/${selected()!.modelID}${(selected()?.modelCount ?? 0) > 1 ? ` +${selected()!.modelCount - 1}` : ""}` : "unknown model"
  const recordedMetrics = () => `${formatCount(selected()?.input ?? 0)} in · ${formatMoney(selected()?.cost ?? 0)}`
  const modelWidth = () => Math.max(1, previewSize().width - cellWidth(recordedMetrics()) - 1)
  const hints = () => dimensions().width >= 110
    ? [searchHint, projectHint, { key: "s", label: "subagents", command: "opcode-sessions.subagents" }, { key: "j/k", label: "move" }, { key: "enter", label: "open", command: "opcode-sessions.select" }, backHint]
    : dimensions().width >= 60 ? [searchHint, projectHint, backHint] : [backHint]
  if (props.screen) props.screen.mount()
  else useInputScope(api, BROWSER_MODE)
  const timer = setInterval(() => { if (!state().syncing) void props.model.load() }, 5_000)
  onCleanup(() => clearInterval(timer))

  return (
    <box width="100%" height="100%" minHeight={0} flexDirection="column">
      <Page
        title="All sessions"
        subtitle={dimensions().width >= 80 ? "across OpenCode projects" : undefined}
        actions={<KeyHints items={hints()} />}
        filters={
          <box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
            <FilterChip label="query" value={shorten(state().query || ".*", Math.max(3, Math.min(24, Math.floor(dimensions().width * 0.13))))} />
            <Show when={dimensions().width >= 60}><FilterChip label="project" value={shorten(project(), Math.max(3, Math.min(22, Math.floor(dimensions().width * 0.18))))} /></Show>
            <Show when={dimensions().width >= 90}><FilterChip label="subagents" value={state().showSubagents ? "shown" : "hidden"} /></Show>
            <text height={1} fg={palette.muted}>{formatCount(state().rows.length)} sessions</text>
          </box>
        }
        footer={
          <box flexDirection="row" justifyContent="space-between" gap={1} flexGrow={1} minWidth={0}>
            <text height={1} width={footerWidth()} fg={state().syncError ? palette.error : palette.muted}>
              {shorten(state().syncError || `${state().syncing ? "Syncing · " : state().loading ? "Searching · " : ""}${sourceInfo()}`, footerWidth())}
            </text>
            <text height={1} fg={palette.value}>{selectedProject()}</text>
          </box>
        }
      >
        <Show when={!state().searchError && state().rows.length > 0} fallback={
          <Card grow minHeight={3}>
            <CenterEmpty title={state().searchError ? "Search unavailable" : state().loading || state().syncing ? "Loading sessions" : "No matching sessions"} description={state().searchError || "Clear filters or refresh to synchronize indexed sessions."} />
          </Card>
        }>
          <box flexDirection="row" gap={1} flexGrow={1} minWidth={0} minHeight={0}>
            <Card grow minHeight={3}>
              <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column" onSizeChange={function (this: BoxRenderable) {
                setListSize((previous) => previous.width === this.width && previous.height === this.height ? previous : { width: this.width, height: this.height })
              }}>
                <For each={state().rows.slice(window().start, window().start + window().size)}>{(row, position) => {
                  const active = () => window().start + position() === window().selected
                  const age = () => updatedAge(row.updatedAt)
                  const summary = () => `${shorten(projectName(row.directory), Math.min(18, Math.max(3, Math.floor(listSize().width * 0.3))))}  ${age()}`
                  const summaryWidth = () => cellWidth(summary())
                  const titleWidth = () => Math.max(0, listSize().width - summaryWidth() - 1)
                  const marker = () => row.id === props.currentSession() ? "[current] " : row.parentID ? "[subagent] " : ""
                  const fittedMarker = () => shorten(marker(), Math.max(0, titleWidth() - 2))
                  return (
                    <box height={1} minHeight={1} flexShrink={0} width="100%" flexDirection="row" justifyContent="space-between" gap={1} backgroundColor={active() ? palette.selectedBackground : undefined}>
                      <text height={1} width={titleWidth()} fg={active() ? palette.selectedText : palette.text}>
                        {active() ? "> " : "  "}<span style={{ fg: active() ? palette.selectedText : row.id === props.currentSession() ? palette.success : palette.accent }}>{fittedMarker()}</span>{shorten(row.title, Math.max(0, titleWidth() - 2 - cellWidth(fittedMarker())))}
                      </text>
                      <text height={1} width={summaryWidth()} fg={active() ? palette.selectedText : palette.muted}>{summary()}</text>
                    </box>
                  )
                }}</For>
              </box>
            </Card>
            <Show when={showPreview() && selected()}>
              <box width={previewWidth()} flexShrink={0} flexDirection="column" minHeight={0}>
                <Card grow minHeight={3}>
                  <box flexGrow={1} minHeight={0} flexDirection="column" gap={dimensions().height >= 28 ? 1 : 0} onSizeChange={function (this: BoxRenderable) {
                    setPreviewSize((previous) => previous.width === this.width && previous.height === this.height ? previous : { width: this.width, height: this.height })
                  }}>
                    <box flexDirection="row" justifyContent="space-between" gap={1} height={1} flexShrink={0}>
                      <text height={1} width={modelWidth()} fg={palette.accent}>{shorten(modelName(), modelWidth())}</text>
                      <text height={1} fg={palette.value}>{recordedMetrics()}</text>
                    </box>
                    <text height={1} flexShrink={0} fg={palette.text}><b>{shorten(selected()?.title ?? "", previewSize().width)}</b></text>
                    <text height={1} flexShrink={0} fg={palette.value}>{shorten(projectName(selected()?.directory ?? ""), previewSize().width)}</text>
                    <text height={1} flexShrink={0} fg={palette.muted}>{shorten(api.ui.format.path(selected()?.directory ?? ""), previewSize().width)}</text>
                    <text height={1} flexShrink={0} fg={palette.muted}>{formatCount(selected()?.messageCount ?? 0)} indexed messages</text>
                    <text height={1} flexShrink={0} fg={palette.muted}>{shorten(`${formatCount(selected()?.output ?? 0)} out · ${formatCount(selected()?.reasoning ?? 0)} reasoning · cache ${formatCount(selected()?.cacheRead ?? 0)}/${formatCount(selected()?.cacheWrite ?? 0)}`, previewSize().width)}</text>
                    <box flexGrow={1} minHeight={1} overflow="hidden"><text width="100%" height="100%" fg={palette.text}>{selected()?.snippet || "No matching message preview."}</text></box>
                  </box>
                </Card>
              </box>
            </Show>
          </box>
        </Show>
      </Page>
    </box>
  )
}
