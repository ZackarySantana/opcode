/** @jsxImportSource @opentui/solid */

import { KeyHints, usePalette } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import type { TextareaRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { Show, untrack } from "solid-js"
import { fields, type Browser, type Field } from "./browser"
import { PLUGIN_ID } from "./domain"

const command = (name: string) => `${PLUGIN_ID}.editor.${name}`

const scopeNote = {
  global: "every project; a project snippet with the same name replaces it there",
  project: "this project only; replaces a global snippet with the same name",
} as const

/** The fields of one snippet. tab moves between them, ctrl+s saves, and esc goes back. */
export function SnippetEditor(props: { browser: Browser }) {
  const api = usePlugin()
  const palette = usePalette()
  const dimensions = useTerminalDimensions()
  const editing = () => props.browser.editing()!
  const field = () => editing().field
  const draft = () => editing().draft
  // The inputs own their text once mounted; the draft only follows it, so it survives a confirmation replacing the editor.
  const initial = untrack(draft)
  const move = (by: number) => props.browser.update({ field: fields[(fields.indexOf(field()) + by + fields.length) % fields.length] })
  const toggleScope = () => props.browser.update({ draft: { scope: draft().scope === "global" ? "project" : "global" } })
  useDialogCommands(api, () => [
    { id: command("next"), bind: "tab", run: () => move(1) },
    { id: command("previous"), bind: "shift+tab", run: () => move(-1) },
    { id: command("save"), bind: "ctrl+s", run: () => void props.browser.save() },
    { id: command("cancel"), bind: "escape", run: () => void props.browser.cancel() },
    { id: command("scope"), bind: "space,left,right,h,l", enabled: () => field() === "scope", run: toggleScope },
    { id: command("scope.next"), bind: "return", enabled: () => field() === "scope", run: () => move(1) },
  ])
  const title = () => editing().from ? `Edit @${editing().from!.name}` : "New snippet"
  let body: TextareaRenderable | undefined
  const input = (name: Exclude<Field, "scope" | "body">, placeholder: string) => (
    <input focused={field() === name} value={initial[name]} placeholder={placeholder} flexGrow={1}
      onInput={(value) => props.browser.update({ draft: { [name]: value } })} onSubmit={() => move(1)}
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
        <textarea ref={(element: TextareaRenderable) => { body = element }} focused={field() === "body"} initialValue={initial.body}
          height={Math.max(4, Math.min(24, dimensions().height - 22))} flexGrow={1} wrapMode="word"
          placeholder="What @name attaches. @other-snippet references expand." textColor={palette.text} focusedTextColor={palette.text} placeholderColor={palette.muted}
          onContentChange={() => props.browser.update({ draft: { body: body?.plainText ?? "" } })} />
      </Row>
      <Show when={editing().error}>{(error) => <text minWidth={0} wrapMode="word" paddingTop={1} fg={palette.error}>! {error()}</text>}</Show>
      <Show when={editing().saving}><text paddingTop={1} fg={palette.muted}>Saving…</text></Show>
      <box paddingTop={1} minWidth={0}>
        <KeyHints items={[
          { key: "ctrl+s", label: "save", command: command("save") },
          { key: "tab/shift+tab", label: "next/previous field", command: command("next") },
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
