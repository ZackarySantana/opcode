/** @jsxImportSource @opentui/solid */

import { More, RefreshLine, SidebarItem } from "@opcode/tabs"
import { openLink } from "@opcode/tabs/open"
import { Section, usePalette } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { PREFIX, TITLE } from "./dialog"
import type { PullRequestsController } from "./host"
import { sidebarEntries, view } from "./model"
import { sidebarItem } from "./style"

/** Only what waits on you; /ghpr has everything else. */
export function Sidebar(props: { prs: PullRequestsController }) {
  const api = usePlugin()
  const palette = usePalette()
  const entries = createMemo(() => { const snapshot = props.prs.snapshot(); return snapshot ? sidebarEntries(view(snapshot), props.prs.settings()) : [] })
  const limit = () => props.prs.settings().sidebarItems
  const hidden = () => props.prs.snapshot()?.requested.hidden
  return (
    <box paddingTop={1}>
      <Section title="Pull requests">
        <box flexDirection="column" minWidth={0} gap={1}>
          <For each={entries().slice(0, limit())}>{(entry) => (
            <SidebarItem item={sidebarItem(entry, props.prs.snapshot()!.viewer, props.prs.now(), palette)} open={() => openLink(api, TITLE, entry.pr.url)} />
          )}</For>
          <Show when={props.prs.snapshot() && !entries().length}><text fg={palette.muted}>Nothing waiting on you</text></Show>
          <Show when={entries().length > limit()}><More count={entries().length - limit()} pointer="/ghpr" command={`${PREFIX}.open`} /></Show>
          <Show when={hidden()}><text minWidth={0} wrapMode="word" fg={palette.warning}>! {hidden()} review requests hidden by GitHub; see /ghpr</text></Show>
          <Show when={props.prs.error()}>{(error) => <text minWidth={0} wrapMode="word" fg={palette.error}>! {error()}</text>}</Show>
          <RefreshLine refreshing={props.prs.refreshing()} next={props.prs.nextRefresh()} />
        </box>
      </Section>
    </box>
  )
}
