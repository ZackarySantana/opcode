/** @jsxImportSource @opentui/solid */

import { More, SidebarItem, useClick, useRefreshCountdown } from "@opcode/tabs"
import { age } from "@opcode/tabs/format"
import { openLink } from "@opcode/tabs/open"
import { Section, usePalette } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import type { FeedsClient } from "./client"
import { PLUGIN_ID, sidebarLayout } from "./model"
import { phaseStyle } from "./style"

/** Only what needs attention; /feed also lists the operational status pages. */
export function Sidebar(props: { feeds: FeedsClient }) {
  const api = usePlugin()
  const palette = usePalette()
  const view = createMemo(() => props.feeds.timeline("sidebar"))
  const layout = createMemo(() => sidebarLayout(view(), props.feeds.settings().sidebarItems))
  const countdown = useRefreshCountdown(() => props.feeds.refreshing(), () => props.feeds.nextRefresh())
  return (
    <Show when={props.feeds.subscriptions().length || props.feeds.error()}>
      <box paddingTop={1}>
        <Section title="Feeds" detail={countdown()}>
          <Show when={layout().entries.length || layout().upcoming.length || view().unreachable.length || props.feeds.error()}>
            <box flexDirection="column" minWidth={0} gap={1}>
              <For each={layout().entries}>{(entry) => (
                <SidebarItem open={() => openLink(api, "Feed", entry.link)} item={{
                  key: entry.key, mark: phaseStyle(entry.phase, palette), head: entry.source, detail: entry.status,
                  time: age(entry.time, props.feeds.now()), title: entry.title, link: entry.link,
                }} />
              )}</For>
              <Show when={layout().hiddenEntries}>
                <More count={layout().hiddenEntries} pointer={layout().hiddenUpcoming ? undefined : "/feed"} command={`${PLUGIN_ID}.open`} />
              </Show>
              <Show when={layout().upcoming.length}>
                <box flexDirection="column" minWidth={0}>
                  <For each={layout().upcoming}>{(entry) => {
                    const click = useClick(() => openLink(api, "Feed", entry.link))
                    const line = () => `${entry.source} maintenance scheduled in ${age(props.feeds.now(), entry.time)}`
                    return (
                      <text minWidth={0} wrapMode="word" fg={palette.muted} {...click.handlers}>
                        <span style={{ fg: phaseStyle(entry.phase, palette).color }}>{phaseStyle(entry.phase, palette).glyph}</span> {click.hovered() && entry.link ? <u>{line()}</u> : line()}
                      </text>
                    )
                  }}</For>
                  <Show when={layout().hiddenUpcoming}><More count={layout().hiddenUpcoming} noun="scheduled" pointer="/feed" command={`${PLUGIN_ID}.open`} /></Show>
                </box>
              </Show>
              <Show when={view().unreachable.length}>
                <text minWidth={0} wrapMode="word" fg={palette.error}>! {view().unreachable.map((failure) => failure.source).join(" · ")} unreachable</text>
              </Show>
              <Show when={props.feeds.error()}>{(error) => <text minWidth={0} wrapMode="word" fg={palette.error}>! {error()}</text>}</Show>
            </box>
          </Show>
        </Section>
      </box>
    </Show>
  )
}
