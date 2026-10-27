/** @jsxImportSource @opentui/solid */

import { More, SidebarItem, useClick, type Item } from "@opcode/tabs"
import { age } from "@opcode/tabs/format"
import { Section, usePalette } from "@opcode/ui"
import { createSignal, For, onCleanup, Show } from "solid-js"
import type { AgentState } from "./inbox"
import type { Inbox, InboxRow } from "./inbox-host"
import { projectName } from "./domain"

type Palette = ReturnType<typeof usePalette>

const STATE_LABELS: Record<AgentState, string> = {
  "needs-you": "needs you", failed: "failed", finished: "finished", retrying: "retrying", working: "working",
}

const rowDetail = (row: InboxRow) =>
  [projectName(row.directory), row.agents ? `${row.agents} ${row.agents === 1 ? "agent" : "agents"}` : ""].filter(Boolean).join(" · ")

/** State, project, and subagents, as one line. */
export const rowSummary = (row: InboxRow) => `${STATE_LABELS[row.state]} · ${rowDetail(row)}`

function rowItem(row: InboxRow, number: number, now: number, palette: Palette): Item {
  const [glyph, color] = ({
    "needs-you": ["●", palette.warning], failed: ["✗", palette.error], finished: ["✓", palette.success],
    retrying: ["↻", palette.warning], working: ["○", palette.value],
  } as const)[row.state]
  return {
    // Already-read finishes stay a while, muted.
    key: row.id, mark: { glyph: `${number} ${glyph}`, color: row.read ? palette.muted : color, title: palette.text, strong: row.state === "needs-you" },
    head: STATE_LABELS[row.state], detail: rowDetail(row), time: age(row.since, now), title: row.title,
  }
}

/** Active root sessions in the order they became active, numbered for /go, with a way back after this plugin navigated. */
export function InboxSidebar(props: { inbox: Inbox; limit: number; command: string; pointer?: string }) {
  const palette = usePalette()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(timer))
  const rows = props.inbox.rows
  const back = useClick(() => props.inbox.goBack())
  // Like Later, the section is omitted while there's nothing to show.
  return (
    <Show when={props.inbox.back() || rows().length || props.inbox.error()}>
      <box paddingBottom={1}>
        <Section title="Agents">
          <box flexDirection="column" minWidth={0} gap={1}>
            <Show when={props.inbox.back()}>{(entry) => (
              <text minWidth={0} wrapMode="word" fg={palette.muted} {...back.handlers}>← {back.hovered() ? <u>Back to {entry().title}</u> : `Back to ${entry().title}`}</text>
            )}</Show>
            <For each={rows().slice(0, props.limit)}>{(row, index) => (
              <SidebarItem item={rowItem(row, index() + 1, now(), palette)} open={() => props.inbox.open(row.id)} />
            )}</For>
            <Show when={rows().length > props.limit}><More count={rows().length - props.limit} pointer={props.pointer} command={props.command} /></Show>
            <Show when={props.inbox.error()}>{(error) => <text minWidth={0} wrapMode="word" fg={palette.error}>! {error()}</text>}</Show>
          </box>
        </Section>
      </box>
    </Show>
  )
}
