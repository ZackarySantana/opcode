/** @jsxImportSource @opentui/solid */

import { ItemList, TabbedDialog, useTab, type Item } from "@opcode/tabs"
import { matchesText } from "@opcode/tabs/format"
import { usePalette, useText } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import { createMemo, Show } from "solid-js"
import type { Browser } from "./browser"
import { PLUGIN_ID, type Scope } from "./domain"
import type { SnippetEntry } from "./service"

const command = (name: string) => `${PLUGIN_ID}.${name}`
const key = (row: SnippetEntry) => `${row.scope}/${row.name}`
// Project snippets come first: they replace global ones with the same name.
const order: readonly Scope[] = ["project", "global"]

export function SnippetsDialog(props: { browser: Browser }) {
  return (
    <TabbedDialog prefix={PLUGIN_ID} refreshing={props.browser.state().loading} refresh={() => void props.browser.load()} tabs={[
      { label: "Snippets", placeholder: "search snippets", render: () => <Snippets browser={props.browser} /> },
    ]} />
  )
}

/** Snippets by scope with a preview of their text; enter inserts `#name` into the prompt. */
function Snippets(props: { browser: Browser }) {
  const api = usePlugin()
  const tab = useTab()
  const palette = usePalette()
  const text = useText()
  const state = () => props.browser.state()
  const groups = createMemo(() => {
    const rows = state().rows.filter((row) => matchesText([row.name, ...row.aliases, row.description ?? "", row.body].join(" "), tab.query()))
    return order.map((scope) => ({ title: scope.toUpperCase(), rows: rows.filter((row) => row.scope === scope) }))
  })
  // The list outlines its first item until another is focused.
  const focused = () => {
    const rows = groups().flatMap((group) => group.rows)
    return rows.find((row) => key(row) === props.browser.focus[0]()) ?? rows[0]
  }
  const item = (row: SnippetEntry): Item => {
    const unavailable = row.overridden || row.conflict
    const preview = text.shorten(row.body.replace(/\s+/g, " ").trim(), Math.max(20, (tab.width() - 6) * 2))
    return {
      key: key(row),
      mark: {
        glyph: row.conflict ? "!" : unavailable ? "○" : "●",
        color: row.conflict ? palette.warning : unavailable ? palette.muted : row.scope === "project" ? palette.accent : palette.value,
        title: unavailable ? palette.muted : palette.text,
        strong: false,
      },
      head: `#${row.name}`,
      detail: row.conflict ? "skill conflict" : row.overridden ? "overridden" : undefined,
      time: row.aliases.map((alias) => `#${alias}`).join(" "),
      title: row.description ?? preview,
      summary: row.description ? preview : undefined,
    }
  }
  const idle = () => !tab.typing()
  const withFocused = (run: (row: SnippetEntry) => Promise<void>) => () => { const row = focused(); if (row) void run(row) }
  useDialogCommands(api, () => [
    { id: command("new"), bind: "n", enabled: idle, run: () => void props.browser.author({}) },
    { id: command("edit"), bind: "e", enabled: idle, run: withFocused((row) => props.browser.author({ name: row.name, scope: row.scope })) },
    { id: command("delete"), bind: "d", enabled: idle, run: withFocused(props.browser.remove) },
  ])
  return (
    <ItemList focus={props.browser.focus} open={withFocused(props.browser.insert)}
      groups={groups().map((group) => ({ title: group.title, items: group.rows.map(item) }))}
      empty={tab.query() ? "No matching snippets." : state().loading ? "Loading…" : "No snippets yet. Press n to write one in a new chat."}
      hints={[
        { key: "↑/↓ j/k", label: "move", command: tab.command("down") },
        { key: "enter", label: "insert", command: tab.command("activate") },
        { key: "n", label: "new", command: command("new") },
        { key: "e", label: "edit in chat", command: command("edit") },
        { key: "d", label: "delete", command: command("delete") },
        { key: "/", label: "search", command: tab.command("search") },
        { key: "r", label: "refresh", command: tab.command("refresh") },
      ]}
      header={<Show when={state().error}>{(error) => <text minWidth={0} wrapMode="word" fg={palette.error}>! {error()}</text>}</Show>} />
  )
}
