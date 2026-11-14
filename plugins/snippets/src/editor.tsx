/** @jsxImportSource @opentui/solid */

import { cellWidth, KeyHints, usePalette } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import { SyntaxStyle, type KeyEvent, type TextareaRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createEffect, createMemo, onCleanup, Show, untrack } from "solid-js"
import { fields, type Browser, type Field } from "./browser"
import { PLUGIN_ID, referenceSegments } from "./domain"
import { REFERENCE, snippetKeys } from "./reference"

const command = (name: string) => `${PLUGIN_ID}.editor.${name}`

const scopeNote = {
  global: "every project; a project snippet with the same name replaces it there",
  project: "this project only; replaces a global snippet with the same name",
} as const

/** The fields of one snippet. tab and ↑/↓ move between them, ctrl+s saves, and esc goes back. */
export function SnippetEditor(props: { browser: Browser }) {
  const api = usePlugin()
  const palette = usePalette()
  const dimensions = useTerminalDimensions()
  const editing = () => props.browser.editing()!
  const field = () => editing().field
  const draft = () => editing().draft
  // The inputs own their text once mounted; the draft only follows it, so it survives a confirmation replacing the editor.
  const initial = untrack(draft)
  // tab goes around; ↑/↓ stop at the first and last field.
  const around = (by: number) => () => props.browser.update({ field: fields[(fields.indexOf(field()) + by + fields.length) % fields.length] })
  const step = (by: number) => fields[fields.indexOf(field()) + by]
  const towards = (by: number) => () => { const next = step(by); if (next) props.browser.update({ field: next }) }
  const toggleScope = () => props.browser.update({ draft: { scope: draft().scope === "global" ? "project" : "global" } })
  useDialogCommands(api, () => [
    { id: command("next"), bind: "tab", run: around(1) },
    { id: command("previous"), bind: "shift+tab", run: around(-1) },
    // In the text, ↑/↓ move between its lines; leaving it from its first or last line is handled there.
    { id: command("down"), bind: "down", enabled: () => field() !== "body" && !!step(1), run: towards(1) },
    { id: command("up"), bind: "up", enabled: () => field() !== "body" && !!step(-1), run: towards(-1) },
    { id: command("save"), bind: "ctrl+s", run: () => void props.browser.save() },
    { id: command("cancel"), bind: "escape", run: () => void props.browser.cancel() },
    { id: command("scope"), bind: "space,left,right,h,l", enabled: () => field() === "scope", run: toggleScope },
    { id: command("scope.next"), bind: "return", enabled: () => field() === "scope", run: towards(1) },
  ])
  const title = () => editing().from ? `Edit @${editing().from!.name}` : "New snippet"
  let body: TextareaRenderable | undefined
  // References to snippets in the text are purple, as in the list's preview.
  const keys = createMemo(() => snippetKeys(props.browser.state().rows))
  const renderer = useRenderer()
  const syntax = SyntaxStyle.create(renderer.nativeScene)
  const referenceStyle = syntax.registerStyle("snippet.reference", { fg: REFERENCE })
  // A style the renderer still draws is destroyed only once it is idle.
  onCleanup(() => void renderer.idle().then(() => syntax.destroy()))
  const highlight = () => {
    if (!body || body.isDestroyed) return
    body.clearAllHighlights()
    body.plainText.split("\n").forEach((line, row) => {
      let column = 0
      for (const segment of referenceSegments(line, (key) => keys().has(key))) {
        const width = cellWidth(segment.text)
        if (segment.reference) body!.addHighlight(row, { start: column, end: column + width, styleId: referenceStyle })
        column += width
      }
    })
  }
  createEffect(() => { keys(); highlight() })
  // Entering the text from another field starts from wherever its cursor was left.
  // The textarea keeps the keyboard when another field is focused, so it lets go itself.
  createEffect(() => { if (field() !== "body" && body && !body.isDestroyed) body.blur() })
  /** ↑ on the text's first line, or ↓ on its last, moves to the field above or below, if there is one. */
  const leaveText = (key: KeyEvent) => {
    if (!body || key.ctrl || key.meta || key.shift) return
    const row = body.visualCursor.visualRow
    const by = key.name === "up" && row <= 0 ? -1 : key.name === "down" && row >= body.virtualLineCount - 1 ? 1 : 0
    if (!by || !step(by)) return
    key.preventDefault()
    towards(by)()
  }
  const input = (name: Exclude<Field, "scope" | "body">, placeholder: string) => (
    <input focused={field() === name} value={initial[name]} placeholder={placeholder} flexGrow={1}
      onInput={(value) => props.browser.update({ draft: { [name]: value } })} onSubmit={towards(1)}
      textColor={palette.text} focusedTextColor={palette.text} placeholderColor={palette.muted} />
  )
  return (
    <box width="100%" flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} backgroundColor={palette.background}>
      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={palette.accent}><b>{title()}</b></text>
        <KeyHints items={[{ key: "esc", label: editing().back ? "back" : "close", command: command("cancel") }]} />
      </box>
      <Row label="Name" field="name" focused={field()}>{input("name", "lowercase-with-hyphens")}</Row>
      <Row label="Scope" field="scope" focused={field()}>
        <text wrapMode="word" minWidth={0} fg={palette.muted}>
          <span style={{ fg: draft().scope === "global" ? palette.value : palette.muted }}>{draft().scope === "global" ? "● global" : "○ global"}</span>
          {"  "}
          <span style={{ fg: draft().scope === "project" ? palette.accent : palette.muted }}>{draft().scope === "project" ? "● project" : "○ project"}</span>
          {"  "}{scopeNote[draft().scope]}
        </text>
      </Row>
      <Row label="Description" field="description" focused={field()}>{input("description", "optional, shown in @ completion")}</Row>
      <Row label="Aliases" field="aliases" focused={field()}>{input("aliases", "other names, separated by spaces or commas")}</Row>
      <Row label="Text" field="body" focused={field()}>
        <textarea ref={(element: TextareaRenderable) => { body = element; queueMicrotask(highlight) }} focused={field() === "body"} initialValue={initial.body} syntaxStyle={syntax}
          height={Math.max(4, Math.min(24, dimensions().height - 22))} flexGrow={1} wrapMode="word"
          placeholder="What @name attaches. @other-snippet uses another snippet's current text." textColor={palette.text} focusedTextColor={palette.text} placeholderColor={palette.muted}
          onKeyDown={leaveText}
          onContentChange={() => { props.browser.update({ draft: { body: body?.plainText ?? "" } }); highlight() }} />
      </Row>
      <Show when={editing().error}>{(error) => <text minWidth={0} wrapMode="word" paddingTop={1} fg={palette.error}>! {error()}</text>}</Show>
      <Show when={editing().saving}><text paddingTop={1} fg={palette.muted}>Saving…</text></Show>
      <box paddingTop={1} minWidth={0}>
        <KeyHints items={[
          { key: "ctrl+s", label: "save", command: command("save") },
          { key: "tab ↑/↓", label: "next/previous field", command: command("next") },
          ...field() === "scope" ? [{ key: "space ←/→", label: "switch scope", command: command("scope") }] : [],
          ...field() === "body" ? [{ key: "enter", label: "new line" }] : [{ key: "enter", label: "next field", command: command("next") }],
        ]} />
      </box>
    </box>
  )
}

function Row(props: { label: string; field: Field; focused: Field; children: JSX.Element }) {
  const palette = usePalette()
  const active = () => props.focused === props.field
  return (
    <box flexDirection="row" gap={1} minWidth={0} flexShrink={0} border={["left"]} borderColor={active() ? palette.value : palette.border} paddingLeft={1}>
      <text wrapMode="none" width={12} flexShrink={0} fg={active() ? palette.value : palette.muted}>{props.label}</text>
      <box flexGrow={1} minWidth={0}>{props.children}</box>
    </box>
  )
}
