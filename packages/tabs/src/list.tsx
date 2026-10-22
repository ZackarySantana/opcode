/** @jsxImportSource @opentui/solid */

import { usePalette, useText } from "@opcode/ui"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createMemo, For, onCleanup, Show, type Signal } from "solid-js"
import { TabFrame, useTab, type TabHandlers } from "./dialog"
import { centered, useFocus } from "./focus"
import { matchesText } from "./format"

export type Color = ReturnType<typeof usePalette>["text"]

/** Glyph and color carry urgency; `title` dims settled items, and strong ones are bold. */
export interface Mark {
  glyph: string
  color: Color
  title: Color
  strong: boolean
}

/** One item, as a dialog card or a sidebar entry. */
export interface Item {
  key: string
  mark: Mark
  /** Colored by the mark, e.g. a status. */
  head: string
  /** Muted, after the head. */
  detail?: string
  title: string
  /** Top right, such as its age. */
  time: string
  /** Muted, under the title. */
  summary?: string
  /** Shown under a dialog card, and opened by a click on a sidebar item. */
  link?: string
}

export interface Group {
  title: string
  items: readonly Item[]
}

/** Items under headings, as bordered cards. ↑/↓ outline one; enter or a click opens it. Empty groups are left out. */
export function ItemList(props: {
  groups: readonly Group[]
  open(item: Item): void
  empty: string
  /** Lines above the groups, such as unreachable sources. */
  header?: JSX.Element
  hints: readonly { key: string; label: string; command?: string }[]
  /** Merged into the list's keys, e.g. a step back. */
  handlers?: Partial<TabHandlers>
  /** The outlined item's key, owned by the caller so it survives the list being replaced by a picker. */
  focus?: Signal<string | undefined>
}) {
  const tab = useTab()
  const palette = usePalette()
  const groups = createMemo(() => props.groups.filter((group) => group.items.length))
  const items = createMemo(() => groups().flatMap((group) => group.items))
  const id = (index: number) => tab.command(`item.${index}`)
  let scroll: ScrollBoxRenderable | undefined
  const focus = useFocus(items, (item) => item.key, () => scroll, id, props.focus)
  tab.handle({
    ...props.handlers,
    move: focus.move,
    activate() {
      const item = focus.current()
      if (item) props.open(item)
    },
  })
  return (
    <TabFrame hints={props.hints}>
      <scrollbox ref={scroll} height={tab.height()}>
        <box flexDirection="column" minWidth={0}>
          {props.header}
          <For each={groups()} fallback={<text fg={palette.muted} paddingTop={1}>{props.empty}</text>}>{(group) => <>
            <text fg={palette.accent} flexShrink={0} paddingTop={1}><b>{group.title}</b></text>
            <For each={group.items}>{(item) => {
              const position = () => items().indexOf(item)
              return <ItemCard item={item} id={id(position())} focused={position() === focus.focused()}
                click={() => { focus.focus(item.key); props.open(item) }} />
            }}</For>
          </>}</For>
        </box>
      </scrollbox>
    </TabFrame>
  )
}

function ItemCard(props: { item: Item; id: string; focused: boolean; click(): void }) {
  const palette = usePalette()
  const strong = (text: string) => props.item.mark.strong ? <b>{text}</b> : text
  return (
    // Every card keeps its border so focus moves without shifting layout.
    <box id={props.id} flexDirection="column" minWidth={0} flexShrink={0} border paddingLeft={1} paddingRight={1}
      borderColor={props.focused ? palette.value : palette.background}
      onMouseDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); props.click() }}>
      <box flexDirection="row" justifyContent="space-between" gap={2} minWidth={0}>
        <text wrapMode="none" minWidth={0} flexShrink={1} fg={props.item.mark.color}>
          {props.item.mark.glyph} {strong(props.item.head)}
          <Show when={props.item.detail}><span style={{ fg: palette.muted }}>  {props.item.detail}</span></Show>
        </text>
        <text wrapMode="none" flexShrink={0} fg={palette.muted}>{props.item.time}</text>
      </box>
      <box flexDirection="column" minWidth={0} paddingLeft={2}>
        <text minWidth={0} wrapMode="word" fg={props.item.mark.title}>{strong(props.item.title)}</text>
        <Show when={props.item.summary}><text minWidth={0} wrapMode="word" fg={palette.muted}>{props.item.summary}</text></Show>
        <Show when={props.item.link}><text minWidth={0} wrapMode="none" fg={props.focused ? palette.value : palette.border}>{props.item.link}</text></Show>
      </box>
    </box>
  )
}

/** A selectable list row; the selection is a highlighted bar, as in /context. */
export function Row(props: { selected: boolean; children: JSX.Element }) {
  const palette = usePalette()
  return (
    <box flexDirection="row" height={1} flexShrink={0} gap={2} backgroundColor={props.selected ? palette.selectedBackground : undefined}>
      {props.children}
    </box>
  )
}

export function Heading(props: { title: string }) {
  const palette = usePalette()
  return <text fg={palette.accent} flexShrink={0}><b>{props.title}</b></text>
}

const LABEL_WIDTH = 34

/** A row's content: a fixed-width label, then a detail in its own color. */
export function Line(props: { label: string; labelColor: Color; detail?: string; detailColor?: Color; selected: boolean }) {
  const tab = useTab()
  const palette = usePalette()
  const text = useText()
  const fg = () => props.selected ? palette.selectedText : undefined
  return <>
    <text wrapMode="none" width={LABEL_WIDTH} flexShrink={0} fg={fg() ?? props.labelColor}>{text.shorten(props.label, LABEL_WIDTH)}</text>
    <text wrapMode="none" flexGrow={1} minWidth={0} fg={fg() ?? props.detailColor ?? palette.muted}>
      {text.shorten(props.detail ?? "", Math.max(0, tab.width() - LABEL_WIDTH - 4))}
    </text>
  </>
}

export interface PickerOption {
  key: string
  label: string
  detail?: string
  detailColor?: Color
}

const ALL = "\u0000all"

/**
 * Chooses one option, or all of them, filtered by the box. Replaces the tab's list while open:
 * mount it in place of the list, and `close` it on a pick or esc.
 */
export function Picker(props: {
  options: readonly PickerOption[]
  /** The first row, choosing every option; hidden while searching. */
  all: string
  /** What the options are, plural, e.g. "feeds". */
  noun: string
  /** The enter hint, e.g. "show feed". */
  action: string
  /** The option outlined first. */
  initial?: string
  pick(key: string | undefined): void
  close(): void
}) {
  const tab = useTab()
  const palette = usePalette()
  const rows = createMemo((): PickerOption[] => [
    ...tab.query() ? [] : [{ key: ALL, label: props.all }],
    ...props.options.filter((option) => matchesText(`${option.label} ${option.key}`, tab.query())),
  ])
  const focus = useFocus(rows, (row) => row.key)
  if (props.initial) focus.focus(props.initial)
  const visible = createMemo(() => centered(rows(), focus.current(), tab.height()))
  tab.handle({
    move: focus.move,
    activate() {
      const row = focus.current()
      if (row) props.pick(row.key === ALL ? undefined : row.key)
    },
    back: () => ({ label: "back", run: props.close }),
    placeholder: () => `search ${props.noun}`,
  })
  onCleanup(tab.reset)
  return (
    <TabFrame hints={[
      { key: "↑/↓ j/k", label: "move", command: tab.command("down") },
      { key: "enter", label: props.action, command: tab.command("activate") },
      { key: "/", label: `search ${props.noun}`, command: tab.command("search") },
      { key: "esc", label: "back", command: tab.command("close") },
    ]}>
      <For each={visible()} fallback={<text fg={palette.muted}>No matching {props.noun}.</text>}>{(row) => {
        const selected = () => row === focus.current()
        return (
          <Row selected={selected()}>
            <Line label={`${selected() ? "> " : "  "}${row.label}`} labelColor={palette.text} detail={row.detail} detailColor={row.detailColor} selected={selected()} />
          </Row>
        )
      }}</For>
    </TabFrame>
  )
}
