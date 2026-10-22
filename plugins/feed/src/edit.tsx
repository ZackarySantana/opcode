/** @jsxImportSource @opentui/solid */

import { errorMessage } from "@opcode/core"
import { usePalette, useText } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import { createMemo, For, Match, Switch } from "solid-js"
import { editRows, managerRows, type EditRow } from "./model"
import { candidateURL, presets } from "./presets"
import { TabFrame } from "./frame"
import { FeedLine, Heading, Row } from "./rows"
import { centered, navigationHints, useFocus, type TabProps } from "./tab"

type Actionable = Exclude<EditRow, { kind: "heading" }>
const rowKey = (row: Actionable) => row.kind === "add" ? `add:${row.feedKind}:${row.url}` : row.url
const addLabel = { status: "status page", updates: "updates feed" } as const

/** Subscriptions under a heading per kind. The shared box filters them, and a new URL typed there offers an "Add" row per kind. */
export function Edit(props: TabProps) {
  const api = usePlugin()
  const palette = usePalette()
  const text = useText()
  const rows = createMemo(() => editRows(managerRows(props.feeds.subscriptions(), presets, props.feeds.results()), props.query(), candidateURL(props.query())))
  const actionable = createMemo(() => rows().filter((row): row is Actionable => row.kind !== "heading"))
  const focus = useFocus(actionable, rowKey)
  const visible = createMemo(() => centered(rows(), focus.current(), props.height))
  props.handle({
    move: focus.move,
    activate() {
      const row = focus.current()
      if (!row) return
      if (row.kind === "feed") { props.feeds.toggle(row.url, row.feedKind); return }
      try {
        props.feeds.subscribe(row.url, row.feedKind)
        props.reset()
        focus.focus(row.url)
      } catch (error) {
        api.ui.toast.show({ title: "Feed", message: errorMessage(error), variant: "error" })
      }
    },
  })
  const removable = () => { const row = focus.current(); return row?.kind === "feed" && !row.preset ? row : undefined }
  useDialogCommands(api, () => [{
    id: "opcode-feed.remove", bind: "d", enabled: () => !props.typing() && !!removable(),
    run: () => { const row = removable(); if (row) props.feeds.unsubscribe(row.url) },
  }])

  return (
    <TabFrame height={props.height} hints={[
      ...navigationHints,
      { key: "space", label: "subscribe", command: "opcode-feed.activate" },
      { key: "/", label: "search or add URL", command: "opcode-feed.search" },
      { key: "d", label: "remove custom", command: "opcode-feed.remove" },
    ]}>
      <For each={visible()} fallback={<text fg={palette.muted}>No matching feeds. Paste a full URL to add one.</text>}>{(row) => {
        const selected = () => row === focus.current()
        const marker = () => selected() ? ">" : " "
        return (
          <Switch>
            <Match when={row.kind === "heading" && row}>{(heading) => <Heading title={heading().title} />}</Match>
            <Match when={row.kind === "add" && row}>{(add) => (
              <Row selected={selected()}>
                <text wrapMode="none" flexGrow={1} minWidth={0} fg={selected() ? palette.selectedText : palette.success}>
                  {text.shorten(`${marker()} + Add as ${addLabel[add().feedKind]}: ${add().url}`, props.width)}
                </text>
              </Row>
            )}</Match>
            <Match when={row.kind === "feed" && row}>{(feed) => (
              <Row selected={selected()}>
                <FeedLine label={`${marker()} [${feed().subscribed ? "x" : " "}] ${feed().title}${feed().preset ? "" : " (custom)"}`}
                  labelColor={feed().subscribed ? palette.value : palette.text} selected={selected()} width={props.width} now={props.feeds.now()}
                  kind={feed().feedKind} result={feed().result} showState={feed().subscribed} />
              </Row>
            )}</Match>
          </Switch>
        )
      }}</For>
    </TabFrame>
  )
}
