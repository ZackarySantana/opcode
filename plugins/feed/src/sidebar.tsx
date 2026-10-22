/** @jsxImportSource @opentui/solid */

import { Section, usePalette } from "@opcode/ui"
import { createMemo, For, Show } from "solid-js"
import type { FeedsController } from "./host"
import { age, sidebarLayout, windowLabel, type TimelineEntry } from "./model"
import { phaseStyle } from "./style"

function Entry(props: { entry: TimelineEntry; now: number }) {
  const palette = usePalette()
  const style = () => phaseStyle(props.entry.phase, palette)
  return (
    <box flexDirection="column" minWidth={0}>
      <box flexDirection="row" justifyContent="space-between" minWidth={0} gap={1}>
        <text wrapMode="none" minWidth={0} flexShrink={1} fg={style().color}>
          {style().glyph} {style().strong ? <b>{props.entry.source}</b> : props.entry.source}
          <Show when={props.entry.status}><span style={{ fg: palette.muted }}> · {props.entry.status}</span></Show>
        </text>
        <text wrapMode="none" flexShrink={0} fg={palette.muted}>{age(props.entry.time, props.now)}</text>
      </box>
      <box minWidth={0} paddingLeft={2}><text minWidth={0} wrapMode="word" fg={style().title}>{props.entry.title}</text></box>
    </box>
  )
}

export function Sidebar(props: { feeds: FeedsController }) {
  const palette = usePalette()
  const view = createMemo(() => props.feeds.timeline("sidebar"))
  const layout = createMemo(() => sidebarLayout(view()))
  // The last overflow line carries the pointer to /feed.
  const pointer = () => layout().hiddenUpcoming ? "upcoming" : layout().hiddenEntries ? "entries" : undefined
  const More = (more: { count: number; noun?: string; last: boolean }) => (
    <text minWidth={0} wrapMode="word" fg={palette.muted}>
      +{more.count} more{more.noun ? ` ${more.noun}` : ""}{more.last ? <> in <span style={{ fg: palette.text }}>/feed</span></> : ""}
    </text>
  )
  return (
    <Show when={props.feeds.subscriptions().length}>
      <box paddingTop={1}>
        <Section title="Feeds">
          <box flexDirection="column" minWidth={0} gap={1}>
            <Show when={view().operational.length}>
              <text minWidth={0} wrapMode="word" fg={palette.muted}>✓ {view().operational.join(" · ")}</text>
            </Show>
            <For each={layout().entries}>{(entry) => <Entry entry={entry} now={props.feeds.now()} />}</For>
            <Show when={!layout().entries.length && !view().pending}>
              <text fg={palette.muted}>Nothing in the last {windowLabel(props.feeds.settings().windowHours)}</text>
            </Show>
            <Show when={layout().hiddenEntries}><More count={layout().hiddenEntries} last={pointer() === "entries"} /></Show>
            <Show when={layout().upcoming.length}>
              <box flexDirection="column" minWidth={0}>
                <For each={layout().upcoming}>{(entry) => (
                  <text minWidth={0} wrapMode="word" fg={palette.muted}>
                    <span style={{ fg: phaseStyle(entry.phase, palette).color }}>{phaseStyle(entry.phase, palette).glyph}</span> {entry.source} maintenance scheduled in {age(props.feeds.now(), entry.time)}
                  </text>
                )}</For>
                <Show when={layout().hiddenUpcoming}><More count={layout().hiddenUpcoming} noun="scheduled" last /></Show>
              </box>
            </Show>
            <Show when={view().unreachable.length}>
              <text minWidth={0} wrapMode="word" fg={palette.error}>! {view().unreachable.map((failure) => failure.source).join(" · ")} unreachable</text>
            </Show>
          </box>
        </Section>
      </box>
    </Show>
  )
}
