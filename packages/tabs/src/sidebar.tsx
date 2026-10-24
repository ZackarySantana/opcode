/** @jsxImportSource @opentui/solid */

import { usePalette } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import type { MouseEvent } from "@opentui/core"
import { createSignal, onCleanup, Show } from "solid-js"
import { refreshStatus } from "./format"
import type { Item } from "./list"

/**
 * Left click runs the action on release, so a dialog it opens isn't dismissed by that same release landing on its
 * backdrop; hovered lets the line underline what the click opens.
 */
export function useClick(run: () => void) {
  const [hovered, setHovered] = createSignal(false)
  return {
    hovered,
    handlers: {
      onMouseUp: (event: MouseEvent) => { if (event.button !== 0) return; event.stopPropagation(); run() },
      onMouseOver: () => setHovered(true),
      onMouseOut: () => setHovered(false),
    },
  }
}

/** An item in two lines: its mark, head, detail, and age, then its title, underlined on hover when it has a link. A click opens it. */
export function SidebarItem(props: { item: Item; open(): void }) {
  const palette = usePalette()
  const click = useClick(() => props.open())
  return (
    <box flexDirection="column" minWidth={0} {...click.handlers}>
      <box flexDirection="row" justifyContent="space-between" minWidth={0} gap={1}>
        <text wrapMode="none" minWidth={0} flexShrink={1} fg={props.item.mark.color}>
          {props.item.mark.glyph} {props.item.mark.strong ? <b>{props.item.head}</b> : props.item.head}
          <Show when={props.item.detail}><span style={{ fg: palette.muted }}> · {props.item.detail}</span></Show>
        </text>
        <text wrapMode="none" flexShrink={0} fg={palette.muted}>{props.item.time}</text>
      </box>
      <box minWidth={0} paddingLeft={2}>
        <text minWidth={0} wrapMode="word" fg={props.item.mark.title}>{click.hovered() && props.item.link ? <u>{props.item.title}</u> : props.item.title}</text>
      </box>
    </box>
  )
}

/** "+N more", ending with a pointer to the dialog on the last such line; a click runs `command`, which opens it. */
export function More(props: { count: number; noun?: string; pointer?: string; command: string }) {
  const api = usePlugin()
  const palette = usePalette()
  const click = useClick(() => api.keymap.dispatch(props.command))
  const label = () => <>+{props.count} more{props.noun ? ` ${props.noun}` : ""}{props.pointer ? <> in <span style={{ fg: palette.text }}>{props.pointer}</span></> : ""}</>
  return <text minWidth={0} wrapMode="word" fg={palette.muted} {...click.handlers}>{click.hovered() ? <u>{label()}</u> : label()}</text>
}

/** The time to the next refresh, for a section title. Ticks every second on its own, so nothing else re-derives. */
export function useRefreshCountdown(refreshing: () => boolean, next: () => number | undefined) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))
  return () => refreshStatus(refreshing(), next(), now())
}
