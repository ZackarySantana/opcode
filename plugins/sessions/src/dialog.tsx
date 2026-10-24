/** @jsxImportSource @opentui/solid */
import { centered, Picker, Row, TabbedDialog, TabFrame, useTab } from "@opcode/tabs"
import { age } from "@opcode/tabs/format"
import { Card, CenterEmpty, usePalette, useText } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { formatCount, formatMoney } from "@opcode/core"
import { usePlugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { projectName } from "./domain"
import type { BrowserModel } from "./browser"

const PREFIX = "opcode-sessions"

type Props = { model: BrowserModel; open(sessionID: string): void }

export function SessionsDialog(props: Props) {
  return (
    <TabbedDialog prefix={PREFIX} refreshing={props.model.state().syncing} refresh={() => void props.model.refresh()} tabs={[
      { label: "All sessions", placeholder: "regular expression over titles, paths, and message text", render: () => <Browser {...props} /> },
    ]} />
  )
}

/** The box is the search; while p picks a project, it searches projects instead and starts empty again after. */
function Browser(props: Props) {
  const tab = useTab()
  const state = props.model.state
  const [picking, setPicking] = createSignal(false)
  createEffect(on(tab.query, (query) => { if (!picking() && query !== state().query) void props.model.search(query) }, { defer: true }))
  const timer = setInterval(() => { if (!state().syncing) void props.model.load() }, 5_000)
  onCleanup(() => clearInterval(timer))
  const pick = (projectID: string | undefined) => {
    setPicking(false)
    void props.model.filters({ projectID })
  }
  return (
    <Show when={!picking()} fallback={
      <Picker options={state().projects.map((project) => ({ key: project.id, label: project.label, detail: project.directory }))}
        all="All projects" noun="projects" action="filter" initial={state().projectID} pick={pick} close={() => setPicking(false)} />
    }>
      <SessionList {...props} pick={() => { tab.reset(); setPicking(true) }} />
    </Show>
  )
}

function SessionList(props: Props & { pick(): void }) {
  const api = usePlugin()
  const tab = useTab()
  const palette = usePalette()
  const { shorten, cellWidth } = useText()
  const state = props.model.state
  const selected = () => state().rows[state().selected]
  const current = () => { const route = api.ui.router.current(); return route.type === "session" ? route.sessionID : undefined }
  const project = () => state().projects.find((project) => project.id === state().projectID)
  // The status line and a gap sit above the rows.
  const height = () => tab.height() - 2
  // A large dialog is about 88 cells wide.
  const showPreview = () => tab.width() >= 72 && height() >= 10
  const previewWidth = () => Math.max(32, Math.floor(tab.width() * 0.4))
  const listWidth = () => tab.width() - (showPreview() ? previewWidth() + 1 : 0)
  const previewText = () => previewWidth() - 4
  const visible = createMemo(() => centered(state().rows, selected(), height()))
  const idle = () => !tab.typing()

  tab.handle({
    move: (by) => props.model.move(by),
    activate() {
      const row = selected()
      // Enter right after typing waits for the rows that answer the query.
      if (!row || state().outdated) return
      api.ui.dialog.clear()
      props.open(row.id)
    },
    back: () => state().projectID ? { label: "all projects", run: () => void props.model.filters({ projectID: undefined }) } : undefined,
    prefix: () => project()?.label,
  })
  useDialogCommands(api, () => [
    { id: `${PREFIX}.project`, bind: "p", enabled: idle, run: props.pick },
    { id: `${PREFIX}.subagents`, bind: "s", enabled: idle, run: () => void props.model.filters({ showSubagents: !state().showSubagents }) },
    { id: `${PREFIX}.clear`, bind: "x", enabled: idle, run: () => { void props.model.clear(); tab.reset() } },
  ])

  const modelName = () => {
    const row = selected()
    if (!row?.providerID || !row.modelID) return "unknown model"
    return `${row.providerID}/${row.modelID}${row.modelCount > 1 ? ` +${row.modelCount - 1}` : ""}`
  }
  const metrics = () => `${formatCount(selected()?.input ?? 0)} in · ${formatMoney(selected()?.cost ?? 0)}`
  const modelWidth = () => Math.max(1, previewText() - cellWidth(metrics()) - 1)

  return (
    <TabFrame hints={[
      { key: "↑/↓ j/k", label: "move", command: tab.command("down") },
      { key: "enter", label: "open", command: tab.command("activate") },
      { key: "/", label: "search", command: tab.command("search") },
      { key: "p", label: "project", command: `${PREFIX}.project` },
      { key: "s", label: state().showSubagents ? "hide subagents" : "show subagents", command: `${PREFIX}.subagents` },
      { key: "x", label: "clear filters", command: `${PREFIX}.clear` },
      { key: "r", label: "resync", command: tab.command("refresh") },
    ]}>
      <box flexDirection="row" height={1} gap={2} minWidth={0}>
        <text wrapMode="none" flexShrink={0} fg={palette.muted}>
          {formatCount(state().rows.length)}{state().truncated ? "+" : ""} sessions · subagents {state().showSubagents ? "shown" : "hidden"}
          <Show when={state().truncated}><span style={{ fg: palette.warning }}> · partial: scan budget reached</span></Show>
        </text>
        <text wrapMode="none" flexGrow={1} minWidth={0} fg={state().syncError ? palette.error : palette.muted}>{state().syncError || state().syncNotice}</text>
      </box>
      <box flexDirection="row" gap={1} paddingTop={1} height={height() + 1} minWidth={0}>
        <Show when={!state().searchError && state().rows.length} fallback={
          <CenterEmpty title={state().searchError ? "Search unavailable" : state().loading || state().syncing ? "Loading sessions" : "No matching sessions"}
            description={state().searchError || "Clear filters or resynchronize indexed sessions."} />
        }>
          <box flexDirection="column" width={listWidth()} flexShrink={0}>
            <For each={visible()}>{(row) => {
              const active = () => row === selected()
              const summary = () => `${shorten(projectName(row.directory), Math.min(18, Math.max(3, Math.floor(listWidth() * 0.3))))}  ${age(row.updatedAt)}`
              const titleWidth = () => Math.max(0, listWidth() - cellWidth(summary()) - 2)
              const marker = () => shorten(row.id === current() ? "[current] " : row.parentID ? "[subagent] " : "", Math.max(0, titleWidth() - 2))
              return (
                <Row selected={active()}>
                  <text wrapMode="none" width={titleWidth()} flexShrink={0} fg={active() ? palette.selectedText : palette.text}>
                    {active() ? "> " : "  "}<span style={{ fg: active() ? palette.selectedText : row.id === current() ? palette.success : palette.accent }}>{marker()}</span>
                    {shorten(row.title, Math.max(0, titleWidth() - 2 - cellWidth(marker())))}
                  </text>
                  <text wrapMode="none" flexShrink={0} fg={active() ? palette.selectedText : palette.muted}>{summary()}</text>
                </Row>
              )
            }}</For>
          </box>
          <Show when={showPreview() && selected()}>{(row) => (
            <box width={previewWidth()} flexShrink={0} flexDirection="column">
              <Card grow>
                <box flexDirection="row" justifyContent="space-between" gap={1} height={1} flexShrink={0}>
                  <text wrapMode="none" width={modelWidth()} fg={palette.accent}>{shorten(modelName(), modelWidth())}</text>
                  <text wrapMode="none" fg={palette.value}>{metrics()}</text>
                </box>
                <text wrapMode="none" flexShrink={0} fg={palette.text}><b>{shorten(row().title, previewText())}</b></text>
                <text wrapMode="none" flexShrink={0} fg={palette.value}>{shorten(projectName(row().directory), previewText())}</text>
                <text wrapMode="none" flexShrink={0} fg={palette.muted}>{shorten(api.ui.format.path(row().directory), previewText())}</text>
                <text wrapMode="none" flexShrink={0} fg={palette.muted}>{formatCount(row().messageCount)} indexed messages</text>
                <text wrapMode="none" flexShrink={0} fg={palette.muted}>
                  {shorten(`${formatCount(row().output)} out · ${formatCount(row().reasoning)} reasoning · cache ${formatCount(row().cacheRead)}/${formatCount(row().cacheWrite)}`, previewText())}
                </text>
                <box flexGrow={1} minHeight={1} paddingTop={1} overflow="hidden"><text width="100%" fg={palette.text}>{row().snippet || "No matching message preview."}</text></box>
              </Card>
            </box>
          )}</Show>
        </Show>
      </box>
    </TabFrame>
  )
}
