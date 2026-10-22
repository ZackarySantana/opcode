/** @jsxImportSource @opentui/solid */

import { Section, usePalette } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import type { MouseEvent } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { FeedsController } from "./host"
import { age, refreshStatus, sidebarLayout, windowLabel, type TimelineEntry } from "./model"
import { openLink } from "./open"
import { phaseStyle } from "./style"

/** Ticks every second on its own, so the countdown moves without re-deriving the timeline. */
function RefreshLine(props: { feeds: FeedsController }) {
  const palette = usePalette()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))
  return (
    <Show when={refreshStatus(props.feeds.refreshing(), props.feeds.nextRefresh(), now())}>
      {(status) => <text wrapMode="none" fg={palette.muted}>{status()}</text>}
    </Show>
  )
}

/** Left click runs the action; hovered lets the line underline what the click opens. */
function useClick(run: () => void) {
  const [hovered, setHovered] = createSignal(false)
  return {
    hovered,
    handlers: {
      onMouseDown: (event: MouseEvent) => { if (event.button !== 0) return; event.stopPropagation(); run() },
      onMouseOver: () => setHovered(true),
      onMouseOut: () => setHovered(false),
    },
  }
}

function Entry(props: { entry: TimelineEntry; now: number }) {
  const api = usePlugin()
  const palette = usePalette()
  const style = () => phaseStyle(props.entry.phase, palette)
  const click = useClick(() => openLink(api, props.entry.link))
  return (
    <box flexDirection="column" minWidth={0} {...click.handlers}>
      <box flexDirection="row" justifyContent="space-between" minWidth={0} gap={1}>
        <text wrapMode="none" minWidth={0} flexShrink={1} fg={style().color}>
          {style().glyph} {style().strong ? <b>{props.entry.source}</b> : props.entry.source}
          <Show when={props.entry.status}><span style={{ fg: palette.muted }}> · {props.entry.status}</span></Show>
        </text>
        <text wrapMode="none" flexShrink={0} fg={palette.muted}>{age(props.entry.time, props.now)}</text>
      </box>
      <box minWidth={0} paddingLeft={2}>
        <text minWidth={0} wrapMode="word" fg={style().title}>{click.hovered() && props.entry.link ? <u>{props.entry.title}</u> : props.entry.title}</text>
      </box>
    </box>
  )
}

export function Sidebar(props: { feeds: FeedsController }) {
  const api = usePlugin()
  const palette = usePalette()
  const view = createMemo(() => props.feeds.timeline("sidebar"))
  const layout = createMemo(() => sidebarLayout(view(), props.feeds.settings().sidebarItems))
  // The last overflow line carries the pointer to /feed; clicking any of them opens it.
  const pointer = () => layout().hiddenUpcoming ? "upcoming" : layout().hiddenEntries ? "entries" : undefined
  const More = (more: { count: number; noun?: string; last: boolean }) => {
    const click = useClick(() => api.keymap.dispatch("opcode-feed.open"))
    const label = () => <>+{more.count} more{more.noun ? ` ${more.noun}` : ""}{more.last ? <> in <span style={{ fg: palette.text }}>/feed</span></> : ""}</>
    return <text minWidth={0} wrapMode="word" fg={palette.muted} {...click.handlers}>{click.hovered() ? <u>{label()}</u> : label()}</text>
  }
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
                <For each={layout().upcoming}>{(entry) => {
                  const click = useClick(() => openLink(api, entry.link))
                  const line = () => `${entry.source} maintenance scheduled in ${age(props.feeds.now(), entry.time)}`
                  return (
                    <text minWidth={0} wrapMode="word" fg={palette.muted} {...click.handlers}>
                      <span style={{ fg: phaseStyle(entry.phase, palette).color }}>{phaseStyle(entry.phase, palette).glyph}</span> {click.hovered() && entry.link ? <u>{line()}</u> : line()}
                    </text>
                  )
                }}</For>
                <Show when={layout().hiddenUpcoming}><More count={layout().hiddenUpcoming} noun="scheduled" last /></Show>
              </box>
            </Show>
            <Show when={view().unreachable.length}>
              <text minWidth={0} wrapMode="word" fg={palette.error}>! {view().unreachable.map((failure) => failure.source).join(" · ")} unreachable</text>
            </Show>
            <RefreshLine feeds={props.feeds} />
          </box>
        </Section>
      </box>
    </Show>
  )
}
