/** @jsxImportSource @opentui/solid */
import { Card, CenterEmpty, KeyHints, Page, usePalette, useText } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import { CliRenderEvents, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, For, onCleanup, Show } from "solid-js"
import type { Browser } from "./browser"
import type { SnippetEntry } from "./service"

type Color = ReturnType<typeof usePalette>["text"]
const rowID = (row: SnippetEntry) => `opcode-snippets.row.${row.scope}.${row.name}`
const status = (row: SnippetEntry) => row.conflict ? "skill conflict" : row.overridden ? "overridden" : ""

export function SnippetsView(props: { browser: Browser }) {
  const api = usePlugin()
  const palette = usePalette()
  const { shorten } = useText()
  const dimensions = useTerminalDimensions()
  const state = props.browser.state
  const wide = () => dimensions().width >= 100
  let scroll: ScrollBoxRenderable | undefined
  props.browser.screen.mount()

  createEffect(() => {
    const row = props.browser.selected()
    if (!row) return
    const follow = () => { if (scroll && !scroll.isDestroyed) scroll.scrollChildIntoView(rowID(row)) }
    follow()
    // Rows mount after a reload; only this plugin's scrollbox is touched.
    api.renderer.once(CliRenderEvents.FRAME, follow)
    api.renderer.requestRender()
    onCleanup(() => { api.renderer.off(CliRenderEvents.FRAME, follow) })
  })

  const hints = () => [
    { key: "enter", label: "insert", command: "opcode-snippets.insert" },
    { key: "n", label: "new", command: "opcode-snippets.new" },
    { key: "e", label: "edit in chat", command: "opcode-snippets.edit" },
    ...(wide() ? [{ key: "d", label: "delete", command: "opcode-snippets.delete" }] : []),
    { key: "esc", label: "back", command: "opcode-snippets.close" },
  ]
  const preview = () => (
    <Card title={props.browser.selected() ? `#${props.browser.selected()!.name}` : "Preview"} grow minHeight={0}>
      <Show when={props.browser.selected()?.description}><text fg={palette.muted} wrapMode="word">{props.browser.selected()!.description}</text></Show>
      <Show when={props.browser.selected()?.aliases.length}><text fg={palette.muted}>aliases: {props.browser.selected()!.aliases.map((alias) => `#${alias}`).join(" ")}</text></Show>
      <box flexGrow={1} minHeight={0} overflow="hidden"><text width="100%" fg={palette.text} wrapMode="word">{props.browser.selected()?.body ?? ""}</text></box>
    </Card>
  )

  return (
    <Page title="Snippets" subtitle={dimensions().width >= 80 ? "type #name or @name in any prompt" : undefined}
      actions={<KeyHints items={hints()} />}
      footer={(
        <text minWidth={0} flexShrink={1} fg={state().error ? palette.error : palette.muted}>
          {state().error ?? (state().loading ? "Loading snippets" : "Project snippets override global ones with the same name.")}
        </text>
      )}>
      <Show when={state().rows.length} fallback={(
        <Card grow minHeight={3}>
          <CenterEmpty title={state().loading ? "Loading snippets" : "No snippets yet"} description="Press n to write one in a new chat." />
        </Card>
      )}>
        <box flexDirection={wide() ? "row" : "column"} gap={1} flexGrow={1} minWidth={0} minHeight={0}>
          <Card grow minHeight={3}>
            <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} flexGrow={1} flexBasis={0} minHeight={0} scrollX={false}>
              <For each={state().rows}>{(row, index) => {
                const active = () => index() === state().selected
                const fg = (color: Color) => active() ? palette.selectedText : color
                return (
                  <box id={rowID(row)} height={1} flexShrink={0} flexDirection="row" gap={1} minWidth={0}
                    backgroundColor={active() ? palette.selectedBackground : undefined}>
                    <text flexShrink={0} fg={fg(row.overridden || row.conflict ? palette.muted : palette.text)}>{active() ? "> " : "  "}#{row.name}</text>
                    <text flexShrink={0} fg={fg(row.scope === "project" ? palette.accent : palette.value)}>{row.scope}</text>
                    <Show when={status(row)}><text flexShrink={0} fg={fg(row.conflict ? palette.warning : palette.muted)}>{status(row)}</text></Show>
                    <text flexGrow={1} minWidth={0} fg={fg(palette.muted)}>{shorten(row.description ?? "", 60)}</text>
                  </box>
                )
              }}</For>
            </scrollbox>
          </Card>
          <box width={wide() ? Math.floor(dimensions().width * 0.4) : undefined} height={wide() ? undefined : 10} flexShrink={0} flexDirection="column" minHeight={0}>
            {preview()}
          </box>
        </box>
      </Show>
    </Page>
  )
}
