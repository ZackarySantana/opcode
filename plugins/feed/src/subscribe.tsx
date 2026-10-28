/** @jsxImportSource @opentui/solid */

import { centered, Heading, Line, Row, TabFrame, useFocus, useTab } from "@opcode/tabs"
import { usePalette, useText } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import type { FeedsClient } from "./client"
import { editRows, managerRows, PLUGIN_ID, type EditRow } from "./model"
import { candidateURL, presets } from "./presets"
import { feedLine } from "./style"

type Actionable = Exclude<EditRow, { kind: "heading" }>
const rowKey = (row: Actionable) => row.kind === "add" ? `add:${row.feedKind}:${row.url}` : row.url
const addLabel = { status: "status page", release: "release feed" } as const

/** Subscriptions under a heading per kind. The shared box filters them, and a new URL typed there offers an "Add" row per kind. */
export function Subscribe(props: { feeds: FeedsClient }) {
  const api = usePlugin()
  const tab = useTab()
  const palette = usePalette()
  const text = useText()
  const rows = createMemo(() => editRows(managerRows(props.feeds.subscriptions(), presets, props.feeds.results()), tab.query(), candidateURL(tab.query())))
  const actionable = createMemo(() => rows().filter((row): row is Actionable => row.kind !== "heading"))
  const focus = useFocus(actionable, rowKey)
  const visible = createMemo(() => centered(rows(), focus.current(), tab.height() - (props.feeds.error() ? 1 : 0)))
  tab.handle({
    move: focus.move,
    activate() {
      const row = focus.current()
      if (!row) return
      if (row.kind === "feed") { props.feeds.toggle(row.url, row.feedKind); return }
      props.feeds.subscribe(row.url, row.feedKind)
      tab.reset()
      focus.focus(row.url)
    },
  })
  const removable = () => { const row = focus.current(); return row?.kind === "feed" && !row.preset ? row : undefined }
  useDialogCommands(api, () => [{
    id: `${PLUGIN_ID}.remove`, bind: "d", enabled: () => !tab.typing() && !!removable(),
    run: () => { const row = removable(); if (row) props.feeds.unsubscribe(row.url) },
  }])

  return (
    <TabFrame hints={[
      ...tab.navigation,
      { key: "space", label: "subscribe", command: tab.command("activate") },
      { key: "/", label: "search or add URL", command: tab.command("search") },
      { key: "d", label: "remove custom", command: `${PLUGIN_ID}.remove` },
    ]}>
      <Show when={props.feeds.error()}>{(error) => <text minWidth={0} wrapMode="word" fg={palette.error}>! {error()}</text>}</Show>
      <For each={visible()} fallback={<text fg={palette.muted}>No matching feeds. Paste a full URL to add one.</text>}>{(row) => {
        const selected = () => row === focus.current()
        const marker = () => selected() ? ">" : " "
        return (
          <Switch>
            <Match when={row.kind === "heading" && row}>{(heading) => <Heading title={heading().title} />}</Match>
            <Match when={row.kind === "add" && row}>{(add) => (
              <Row selected={selected()}>
                <text wrapMode="none" flexGrow={1} minWidth={0} fg={selected() ? palette.selectedText : palette.success}>
                  {text.shorten(`${marker()} + Add as ${addLabel[add().feedKind]}: ${add().url}`, tab.width())}
                </text>
              </Row>
            )}</Match>
            <Match when={row.kind === "feed" && row}>{(feed) => {
              const state = () => feed().subscribed ? feedLine(feed().result, feed().feedKind, props.feeds.now(), palette) : undefined
              return (
                <Row selected={selected()}>
                  <Line label={`${marker()} [${feed().subscribed ? "x" : " "}] ${feed().title}${feed().preset ? "" : " (custom)"}`}
                    labelColor={feed().subscribed ? palette.value : palette.text} selected={selected()} detail={state()?.detail} detailColor={state()?.detailColor} />
                </Row>
              )
            }}</Match>
          </Switch>
        )
      }}</For>
    </TabFrame>
  )
}
