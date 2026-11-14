/** @jsxImportSource @opentui/solid */

import { ItemList, TabbedDialog, useTab, type Item } from "@opcode/tabs"
import { matchesText } from "@opcode/tabs/format"
import { usePalette, useText } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { keyOf, type Browser } from "./browser"
import { PLUGIN_ID, type Scope } from "./domain"
import { SnippetEditor } from "./editor"
import type { SnippetEntry } from "./service"

const command = (name: string) => `${PLUGIN_ID}.${name}`
// Project snippets come first: they replace global ones with the same name.
const order: readonly Scope[] = ["project", "global"]

/** The list, or the editor while a snippet is being written. */
export function SnippetsDialog(props: { browser: Browser }) {
  return (
    <Show when={props.browser.editing()} fallback={
      <TabbedDialog prefix={PLUGIN_ID} refreshing={props.browser.state().loading} refresh={() => void props.browser.load()} tabs={[
        { label: "Snippets", placeholder: "search snippets", render: () => <Snippets browser={props.browser} /> },
      ]} />
    }>
      <SnippetEditor browser={props.browser} />
    </Show>
  )
}

/** Snippets by scope beside a preview of the outlined one; enter inserts `@name` into the prompt. */
function Snippets(props: { browser: Browser }) {
  const api = usePlugin()
  const tab = useTab()
  const palette = usePalette()
  const text = useText()
  const [raw, setRaw] = createSignal(false)
  const state = () => props.browser.state()
  const groups = createMemo(() => {
    const rows = state().rows.filter((row) => matchesText([row.name, ...row.aliases, row.description ?? "", row.body].join(" "), tab.query()))
    return order.map((scope) => ({ title: scope.toUpperCase(), rows: rows.filter((row) => row.scope === scope) }))
  })
  // The list outlines its first item until another is focused.
  const focused = () => {
    const rows = groups().flatMap((group) => group.rows)
    return rows.find((row) => keyOf(row) === props.browser.focus[0]()) ?? rows[0]
  }
  const item = (row: SnippetEntry): Item => {
    const unavailable = row.overridden || row.conflict
    const preview = text.shorten(row.body.replace(/\s+/g, " ").trim(), Math.max(20, tab.width() * 0.45 - 6))
    return {
      key: keyOf(row),
      mark: {
        glyph: row.conflict || row.problems.length ? "!" : unavailable ? "○" : "●",
        color: row.conflict || row.problems.length ? palette.warning : unavailable ? palette.muted : row.scope === "project" ? palette.accent : palette.value,
        title: unavailable ? palette.muted : palette.text,
        strong: false,
      },
      head: `@${row.name}`,
      detail: row.conflict ? "skill conflict" : row.overridden ? "overridden" : row.problems.length ? "broken reference" : undefined,
      time: row.aliases.map((alias) => `@${alias}`).join(" "),
      title: row.description ?? preview,
      summary: row.description ? preview : undefined,
    }
  }
  const idle = () => !tab.typing()
  const withFocused = (run: (row: SnippetEntry) => unknown) => () => { const row = focused(); if (row) void run(row) }
  const expands = () => { const row = focused(); return !!row && row.expanded !== row.body }
  useDialogCommands(api, () => [
    { id: command("new"), bind: "n", enabled: idle, run: () => props.browser.create() },
    { id: command("edit"), bind: "e", enabled: idle, run: withFocused(props.browser.edit) },
    { id: command("duplicate"), bind: "y", enabled: idle, run: withFocused(props.browser.duplicate) },
    { id: command("delete"), bind: "d", enabled: idle, run: withFocused(props.browser.remove) },
    { id: command("message"), bind: "m", enabled: idle, run: () => void props.browser.saveMessage(true) },
    { id: command("raw"), bind: "v", enabled: () => idle() && expands(), run: () => setRaw((value) => !value) },
  ])
  return (
    <ItemList focus={props.browser.focus} open={withFocused(props.browser.insert)}
      groups={groups().map((group) => ({ title: group.title, items: group.rows.map(item) }))}
      empty={tab.query() ? "No matching snippets." : state().loading ? "Loading…" : "No snippets yet. Press n to write one, or m to save a message."}
      aside={() => <Show when={focused()}>{(row) => <Preview row={row()} raw={raw() && expands()} />}</Show>}
      hints={[
        { key: "↑/↓ j/k", label: "move", command: tab.command("down") },
        { key: "enter", label: "insert", command: tab.command("activate") },
        { key: "e", label: "edit", command: command("edit") },
        { key: "n", label: "new", command: command("new") },
        { key: "y", label: "duplicate", command: command("duplicate") },
        { key: "d", label: "delete", command: command("delete") },
        { key: "m", label: "save a message", command: command("message") },
        ...expands() ? [{ key: "v", label: raw() ? "show expanded" : "show raw", command: command("raw") }] : [],
        { key: "/", label: "search", command: tab.command("search") },
        { key: "r", label: "refresh", command: tab.command("refresh") },
      ]}
      header={<Show when={state().error}>{(error) => <text minWidth={0} wrapMode="word" fg={palette.error}>! {error()}</text>}</Show>} />
  )
}

/** Everything about one snippet: where it lives, why `@name` might not reach it, what uses it, and what it attaches. */
function Preview(props: { row: SnippetEntry; raw: boolean }) {
  const palette = usePalette()
  const flags = () => [
    props.row.overridden && "Overridden: @name inserts the project snippet with the same name.",
    props.row.conflict && `Skill conflict: another skill named ${props.row.name} replaces this snippet.`,
  ].filter((flag): flag is string => !!flag)
  return (
    <box flexDirection="column" width="100%" minWidth={0} paddingTop={1}>
      <text wrapMode="none" minWidth={0} fg={props.row.scope === "project" ? palette.accent : palette.value}>
        <b>@{props.row.name}</b><span style={{ fg: palette.muted }}>  {props.row.scope}</span>
      </text>
      <text wrapMode="char" minWidth={0} fg={palette.muted}>{props.row.path}</text>
      <Show when={props.row.description}>{(description) => <text wrapMode="word" minWidth={0} fg={palette.text}>{description()}</text>}</Show>
      <Show when={props.row.aliases.length}><text wrapMode="word" minWidth={0} fg={palette.muted}>Aliases: {props.row.aliases.map((alias) => `@${alias}`).join(" ")}</text></Show>
      <For each={flags()}>{(flag) => <text wrapMode="word" minWidth={0} fg={palette.warning}>! {flag}</text>}</For>
      <Show when={props.row.problems.length}>
        <text wrapMode="word" minWidth={0} fg={palette.warning}>! Broken reference: {props.row.problems.join(" ")}</text>
      </Show>
      <Show when={props.row.breaks.length}>
        <text wrapMode="word" minWidth={0} fg={palette.muted}>Used by: {props.row.breaks.map((name) => `@${name}`).join(" ")}</text>
      </Show>
      <text paddingTop={1} fg={palette.accent}>{props.raw ? "RAW TEXT" : props.row.expanded !== props.row.body ? "EXPANDED TEXT" : "TEXT"}</text>
      <text wrapMode="word" minWidth={0} fg={palette.text}>{props.raw ? props.row.body : props.row.expanded}</text>
    </box>
  )
}
