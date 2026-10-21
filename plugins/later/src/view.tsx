/** @jsxImportSource @opentui/solid */

import { formatCount } from "@opcode/core"
import { Card, CenterEmpty, KeyHints, Page, Section, usePalette } from "@opcode/ui"
import { useInputScope, type Screen } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import { CliRenderEvents, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, For, onCleanup, Show, type Accessor } from "solid-js"
import type { LaterItem } from "./domain"
import { MANAGER_MODE } from "./host"
import type { LaterView } from "./model"

const rowID = (id: string) => `opcode-later.item.${id}`

function ItemRow(props: { item: LaterItem; label: string; labelWidth: number; selected: boolean }) {
  const palette = usePalette()
  return (
    <box id={rowID(props.item.id)} flexDirection="row" minWidth={0} flexShrink={0} padding={1}
      backgroundColor={props.selected ? palette.selectedBackground : undefined}>
      <text width={2} fg={props.selected ? palette.selectedText : palette.accent}>{props.selected ? ">" : " "}</text>
      <text width={props.labelWidth} fg={props.selected ? palette.selectedText : props.item.completedAt === undefined ? palette.value : palette.success}>{props.label}</text>
      <text flexGrow={1} minWidth={0} wrapMode="word"
        fg={props.selected ? palette.selectedText : props.item.completedAt === undefined ? palette.text : palette.muted}>{props.item.message}</text>
    </box>
  )
}

export function Manager(props: { view: Accessor<LaterView>; screen?: Screen }) {
  const api = usePlugin()
  const palette = usePalette()
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined
  if (props.screen) props.screen.mount()
  else useInputScope(api, MANAGER_MODE)

  createEffect(() => {
    const selected = props.view().selectedID
    props.view().revision
    dimensions()
    if (!selected) return
    const renderer = api.renderer
    const follow = () => {
      if (scroll && !scroll.isDestroyed) scroll.scrollChildIntoView(rowID(selected))
    }
    follow()
    // Retry after layout when history/new rows have just mounted. Only touch
    // this plugin's scrollbox, never inspect OpenCode's render tree.
    renderer.once(CliRenderEvents.FRAME, follow)
    renderer.requestRender()
    onCleanup(() => { renderer.off(CliRenderEvents.FRAME, follow) })
  })

  const labelWidth = () => Math.max(3, String(props.view().active.length).length + 2)
  const hasItems = () => props.view().active.length > 0 || (props.view().history && props.view().completed.length > 0)
  const actionHints = () => dimensions().width < 100
    ? [{ key: "a", label: "add" }, { key: "enter", label: "paste+complete" }]
    : [
      { key: "a", label: "add" }, { key: "e", label: "edit" },
      { key: "space", label: "complete" }, { key: "enter", label: "paste+complete" },
      { key: "d", label: "delete" },
    ]
  return (
    <Page title="Later" subtitle="global list"
      actions={(
        <box flexDirection="row" minWidth={0} flexWrap="wrap" gap={1} justifyContent="flex-end">
          <KeyHints items={actionHints()} />
          <box onMouseDown={(event) => { if (event.button === 0) api.keymap.dispatch("opcode-later.close") }}>
            <KeyHints items={[{ key: "esc", label: "back" }]} />
          </box>
        </box>
      )}
      filters={(
        <box flexDirection="row" minWidth={0} flexWrap="wrap" gap={1}>
          <text fg={palette.value}>{formatCount(props.view().active.length)} active<span style={{ fg: palette.muted }}> / </span><span style={{ fg: palette.success }}>{formatCount(props.view().completed.length)} completed</span></text>
          <KeyHints items={[{ key: "h", label: "history" }, { key: "J/K", label: "reorder" }]} />
        </box>
      )}
      footer={(
        <box width="100%" flexDirection="row" minWidth={0} justifyContent="space-between" gap={2}>
          <text minWidth={0} flexShrink={1} wrapMode="word" fg={api.theme.text.muted}>{dimensions().width < 80 ? "Shared across projects" : "Changes are shared across projects and OpenCode instances."}</text>
          <text flexShrink={0} fg={palette.value}>{props.view().history ? "history shown" : "active only"}</text>
        </box>
      )}>
      <Card grow minHeight={0}>
        <Show when={hasItems()} fallback={<CenterEmpty title="No items for later" description="Press a to add one." />}>
          <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} flexGrow={1} flexBasis={0} minHeight={0} scrollX={false}>
            <For each={props.view().active}>{(item, index) => (
              <ItemRow item={item} label={`${index() + 1}.`} labelWidth={labelWidth()} selected={props.view().selectedID === item.id} />
            )}</For>
            <Show when={props.view().history && props.view().completed.length}>
              <text fg={palette.accent}><b>COMPLETED HISTORY</b></text>
              <For each={props.view().completed}>{(item) => (
                <ItemRow item={item} label="x" labelWidth={labelWidth()} selected={props.view().selectedID === item.id} />
              )}</For>
            </Show>
          </scrollbox>
        </Show>
      </Card>
    </Page>
  )
}

export function Sidebar(props: { view: Accessor<LaterView> }) {
  const palette = usePalette()
  return (
    <Show when={props.view().active.length}>
      <box paddingTop={1}>
        <Section title="Later">
          <For each={props.view().active}>{(item, index) => (
            <box flexDirection="row" minWidth={0}>
              <text width={Math.max(4, String(props.view().active.length).length + 2)} fg={palette.value}>{index() + 1}.</text>
              <text flexGrow={1} minWidth={0} wrapMode="word" fg={palette.text}>{item.message}</text>
            </box>
          )}</For>
        </Section>
      </box>
    </Show>
  )
}
