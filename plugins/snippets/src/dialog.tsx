/** @jsxImportSource @opentui/solid */

import { ItemList, TabbedDialog, useTab, type Item } from "@opcode/tabs"
import { matchesText } from "@opcode/tabs/format"
import { usePalette, useText } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { keyOf, type Browser } from "./browser"
import { PLUGIN_ID, referenceSegments, type Scope } from "./domain"
import { SnippetEditor } from "./editor"
import { REFERENCE, snippetKeys } from "./reference"
import type { SnippetEntry } from "./service"

const command = (name: string) => `${PLUGIN_ID}.${name}`
const tabs: readonly Scope[] = ["project", "global"]
/** Project and global snippets on their own tabs, or the editor while a snippet is being written. */
export function SnippetsDialog(props: { browser: Browser }) {
  return (
    <Show when={props.browser.editing()} fallback={
      <TabbedDialog prefix={PLUGIN_ID} tab={props.browser.tab} refreshing={props.browser.state().loading} refresh={() => void props.browser.load()}
        tabs={tabs.map((scope) => ({ label: scope === "project" ? "Project" : "Global", placeholder: `search ${scope} snippets`, render: () => <Snippets browser={props.browser} scope={scope} /> }))} />
    }>
      <SnippetEditor browser={props.browser} />
    </Show>
  )
}

/** One scope's snippets beside a preview of the outlined one; enter inserts `@name` into the prompt. */
function Snippets(props: { browser: Browser; scope: Scope }) {
  const api = usePlugin()
  const tab = useTab()
  const palette = usePalette()
  const text = useText()
  const state = () => props.browser.state()
  const keys = createMemo(() => snippetKeys(state().rows))
  const rows = createMemo(() => state().rows.filter((row) => row.scope === props.scope
    && matchesText([row.name, ...row.aliases, row.description ?? "", row.body].join(" "), tab.query())))
  // The list outlines its first item until another is focused.
  const focused = () => rows().find((row) => keyOf(row) === props.browser.focus[0]()) ?? rows()[0]
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
  let scroll: ScrollBoxRenderable | undefined
  const page = (by: number) => scroll?.scrollBy(by * Math.max(1, Math.floor(scroll.viewport.height / 2)))
  useDialogCommands(api, () => [
    { id: command("new"), bind: "n", enabled: idle, run: () => props.browser.create(props.scope) },
    { id: command("edit"), bind: "e", enabled: idle, run: withFocused(props.browser.edit) },
    { id: command("duplicate"), bind: "y", enabled: idle, run: withFocused(props.browser.duplicate) },
    { id: command("delete"), bind: "d", enabled: idle, run: withFocused(props.browser.remove) },
    { id: command("copy"), bind: "c", enabled: idle, run: withFocused(props.browser.copy) },
    { id: command("paste"), bind: "p", enabled: idle, run: () => void props.browser.paste(props.scope) },
    { id: command("preview.down"), bind: "pagedown,shift+down", run: () => page(1) },
    { id: command("preview.up"), bind: "pageup,shift+up", run: () => page(-1) },
  ])
  const empty = () => tab.query() ? "No matching snippets."
    : state().loading ? "Loading…"
    : props.scope === "project" ? "No project snippets. Press n to write one for this project." : "No global snippets. Press n to write one."
  return (
    <ItemList focus={props.browser.focus} open={withFocused(props.browser.insert)}
      groups={[{ title: props.scope === "project" ? "THIS PROJECT" : "EVERY PROJECT", items: rows().map(item) }]}
      empty={empty()}
      aside={() => <Show when={focused()}>{(row) => <Preview row={row()} keys={keys()} scroll={(element) => { scroll = element }} />}</Show>}
      hints={[
        { key: "↑/↓ j/k", label: "move", command: tab.command("down") },
        { key: "enter", label: "insert", command: tab.command("activate") },
        { key: "tab", label: props.scope === "project" ? "global" : "project", command: tab.command("next") },
        { key: "e", label: "edit", command: command("edit") },
        { key: "n", label: "new", command: command("new") },
        { key: "y", label: "duplicate", command: command("duplicate") },
        { key: "d", label: "delete", command: command("delete") },
        { key: "c", label: "copy", command: command("copy") },
        { key: "p", label: "paste", command: command("paste") },
        { key: "pgup/pgdn", label: "scroll preview", command: command("preview.down") },
        { key: "/", label: "search", command: tab.command("search") },
        { key: "r", label: "refresh", command: tab.command("refresh") },
      ]}
      header={<Show when={state().error}>{(error) => <text minWidth={0} wrapMode="word" fg={palette.error}>! {error()}</text>}</Show>} />
  )
}

/** Where a snippet lives, why `@name` might not reach it, what uses it, and its text as written, references in purple. */
function Preview(props: { row: SnippetEntry; keys: ReadonlySet<string>; scroll: (element: ScrollBoxRenderable) => void }) {
  const palette = usePalette()
  let scroll: ScrollBoxRenderable | undefined
  // A newly outlined snippet's text starts at the top.
  createEffect(on(() => keyOf(props.row), () => scroll?.scrollTo(0)))
  const flags = () => [
    props.row.overridden && "Overridden: @name inserts the project snippet with the same name.",
    props.row.conflict && `Skill conflict: another skill named ${props.row.name} replaces this snippet.`,
    props.row.problems.length && `Broken reference: ${props.row.problems.join(" ")}`,
  ].filter((flag): flag is string => !!flag)
  const line = { wrapMode: "word", minWidth: 0, flexShrink: 0 } as const
  return (
    <box flexDirection="column" width="100%" height="100%" minWidth={0} paddingTop={1}>
      <text {...line} wrapMode="none" fg={props.row.scope === "project" ? palette.accent : palette.value}>
        <b>@{props.row.name}</b><span style={{ fg: palette.muted }}>  {props.row.scope}</span>
      </text>
      <text {...line} wrapMode="char" fg={palette.muted}>{props.row.path}</text>
      <Show when={props.row.description}>{(description) => <text {...line} fg={palette.text}>{description()}</text>}</Show>
      <Show when={props.row.aliases.length}><text {...line} fg={palette.muted}>Aliases: {props.row.aliases.map((alias) => `@${alias}`).join(" ")}</text></Show>
      <For each={flags()}>{(flag) => <text {...line} fg={palette.warning}>! {flag}</text>}</For>
      <Show when={props.row.breaks.length}>
        <text {...line} fg={palette.muted}>Used by: {props.row.breaks.map((name) => `@${name}`).join(" ")}</text>
      </Show>
      <scrollbox ref={(element: ScrollBoxRenderable) => { scroll = element; props.scroll(element) }} flexGrow={1} flexShrink={1} minHeight={1} marginTop={1}>
        <text wrapMode="word" minWidth={0} fg={palette.text}>
          <For each={referenceSegments(props.row.body, (key) => props.keys.has(key))}>{(segment) =>
            segment.reference ? <span style={{ fg: REFERENCE }}>{segment.text}</span> : <>{segment.text}</>}</For>
        </text>
      </scrollbox>
    </box>
  )
}
