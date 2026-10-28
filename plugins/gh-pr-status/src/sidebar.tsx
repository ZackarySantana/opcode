/** @jsxImportSource @opentui/solid */

import { More, SidebarItem, useRefreshCountdown } from "@opcode/tabs"
import { openLink } from "@opcode/tabs/open"
import { Section, usePalette } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { TITLE } from "./dialog"
import type { PullRequestsClient } from "./client"
import { PLUGIN_ID, sidebarEntries } from "./model"
import { sidebarItem } from "./style"

/** Review requests waiting on you and your open pull requests, as one list; /ghpr has everything else. */
export function Sidebar(props: { prs: PullRequestsClient }) {
  const api = usePlugin()
  const palette = usePalette()
  const entries = createMemo(() => sidebarEntries(props.prs.view(), props.prs.settings()))
  const limit = () => props.prs.settings().sidebarItems
  const countdown = useRefreshCountdown(() => props.prs.refreshing(), () => props.prs.nextRefresh())
  return (
    <box paddingTop={1}>
      <Section title="Pull requests" detail={countdown()}>
        <Show when={entries().length || props.prs.error()}>
          <box flexDirection="column" minWidth={0} gap={1}>
            <For each={entries().slice(0, limit())}>{(entry) => (
              <SidebarItem item={sidebarItem(entry, props.prs.now(), palette)} open={() => openLink(api, TITLE, entry.pr.url)} />
            )}</For>
            <Show when={entries().length > limit()}><More count={entries().length - limit()} pointer="/ghpr" command={`${PLUGIN_ID}.open`} /></Show>
            <Show when={props.prs.error()}>{(error) => <text minWidth={0} wrapMode="word" fg={palette.error}>! {error()}</text>}</Show>
          </box>
        </Show>
      </Section>
    </box>
  )
}
