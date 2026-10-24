/** @jsxImportSource @opentui/solid */

import { More } from "@opcode/tabs"
import { Section, usePalette } from "@opcode/ui"
import { For, Show } from "solid-js"
import { PREFIX, type LaterController } from "./host"

/** The first active items, numbered in the text color with muted text beside the sections that need attention; omitted while the list is empty. */
export function Sidebar(props: { later: LaterController }) {
  const palette = usePalette()
  const active = () => props.later.snapshot().active
  const limit = () => props.later.settings().sidebarItems
  const shown = () => active().slice(0, limit())
  return (
    <Show when={active().length}>
      <box paddingTop={1}>
        <Section title="Later">
          <For each={shown()}>{(item, index) => (
            <box flexDirection="row" minWidth={0}>
              <text width={String(shown().length).length + 2} flexShrink={0} fg={palette.text}>{index() + 1}.</text>
              <text flexGrow={1} minWidth={0} wrapMode="word" fg={palette.muted}>{item.message}</text>
            </box>
          )}</For>
          <Show when={active().length > limit()}><More count={active().length - limit()} pointer="/later" command={`${PREFIX}.open`} /></Show>
        </Section>
      </box>
    </Show>
  )
}
