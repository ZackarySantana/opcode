/** @jsxImportSource @opentui/solid */

import { usePalette } from "@opcode/ui"
import { createMemo, For, Match, onCleanup, Switch } from "solid-js"
import type { FeedsController } from "./host"
import { managerRows, matchesText, type ManagerRow } from "./model"
import { presets, type FeedKind } from "./presets"
import { TabFrame } from "./frame"
import { FeedLine, Row } from "./rows"
import { centered, useFocus, type TabHandlers } from "./tab"

type PickerRow = { kind: "all" } | { kind: "feed"; row: ManagerRow }
const ALL = "\u0000all"
const pickKey = (row: PickerRow) => row.kind === "all" ? ALL : row.row.url

/** Chooses one subscribed feed of the tab's kind to narrow to, or all of them. Replaces the list while open. */
export function FeedPicker(props: {
  feeds: FeedsController; kind: FeedKind; query: () => string; height: number; width: number
  /** The feed to outline first: the focused item's, so f then enter shows more of it. */
  initial?: string
  handle(handlers: TabHandlers): void
  restore(): void
  pick(feed: string | undefined): void
}) {
  const palette = usePalette()
  const rows = createMemo((): PickerRow[] => [
    ...props.query() ? [] : [{ kind: "all" } as const],
    ...managerRows(props.feeds.subscriptions(), presets, props.feeds.results())
      .filter((row) => row.subscribed && row.kind === props.kind && matchesText(`${row.title} ${row.url}`, props.query()))
      .map((row) => ({ kind: "feed" as const, row })),
  ])
  const focus = useFocus(rows, pickKey)
  if (props.initial) focus.focus(props.initial)
  const visible = createMemo(() => centered(rows(), focus.current(), props.height))
  props.handle({
    move: focus.move,
    activate() {
      const row = focus.current()
      if (row) props.pick(row.kind === "all" ? undefined : row.row.url)
    },
  })
  onCleanup(props.restore)
  return (
    <TabFrame height={props.height} hints={[
      { key: "↑/↓ j/k", label: "move", command: "opcode-feed.down" },
      { key: "enter", label: "show feed", command: "opcode-feed.activate" },
      { key: "/", label: "search feeds", command: "opcode-feed.search" },
      { key: "esc", label: "back", command: "opcode-feed.close" },
    ]}>
      <For each={visible()} fallback={<text fg={palette.muted}>No matching subscribed feeds.</text>}>{(row) => {
        const selected = () => row === focus.current()
        const marker = () => selected() ? "> " : "  "
        return (
          <Switch>
            <Match when={row.kind === "all"}>
              <Row selected={selected()}><text fg={selected() ? palette.selectedText : palette.text}>{marker()}All feeds</text></Row>
            </Match>
            <Match when={row.kind === "feed" && row}>{(feed) => (
              <Row selected={selected()}>
                <FeedLine label={`${marker()}${feed().row.title}`} labelColor={palette.text} selected={selected()} width={props.width}
                  now={props.feeds.now()} kind={feed().row.kind} result={feed().row.result} showState />
              </Row>
            )}</Match>
          </Switch>
        )
      }}</For>
    </TabFrame>
  )
}
