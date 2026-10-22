/** @jsxImportSource @opentui/solid */

import { usePalette } from "@opcode/ui"
import { createMemo, For, Match, onCleanup, Switch } from "solid-js"
import type { FeedsController } from "./host"
import { kinds, kindTitles, managerRows, matchesText, type ManagerRow } from "./model"
import { presets } from "./presets"
import { TabFrame } from "./frame"
import { FeedLine, Heading, Row } from "./rows"
import { centered, useFocus, type TabHandlers } from "./tab"

type PickerRow = { kind: "all" } | { kind: "heading"; title: string } | { kind: "feed"; row: ManagerRow }
type Pickable = Exclude<PickerRow, { kind: "heading" }>
const ALL = "\u0000all"
const pickKey = (row: Pickable) => row.kind === "all" ? ALL : row.row.url

/** Chooses one subscribed feed to narrow the timeline to, or all of them. Replaces the list while open. */
export function FeedPicker(props: {
  feeds: FeedsController; query: () => string; height: number; width: number
  /** The feed to outline first: the focused item's, so f then enter shows more of it. */
  initial?: string
  handle(handlers: TabHandlers): void
  restore(): void
  pick(feed: string | undefined): void
}) {
  const palette = usePalette()
  const rows = createMemo((): PickerRow[] => {
    const subscribed = managerRows(props.feeds.subscriptions(), presets, props.feeds.results())
      .filter((row) => row.subscribed && matchesText(`${row.title} ${row.url}`, props.query()))
    return [
      ...props.query() ? [] : [{ kind: "all" } as const],
      ...kinds.flatMap((kind): PickerRow[] => {
        const group = subscribed.filter((row) => row.kind === kind)
        return group.length ? [{ kind: "heading", title: kindTitles[kind] }, ...group.map((row) => ({ kind: "feed" as const, row }))] : []
      }),
    ]
  })
  const pickable = createMemo(() => rows().filter((row): row is Pickable => row.kind !== "heading"))
  const focus = useFocus(pickable, pickKey)
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
            <Match when={row.kind === "heading" && row}>{(heading) => <Heading title={heading().title} />}</Match>
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
