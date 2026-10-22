/** @jsxImportSource @opentui/solid */

import { Card, KeyHints, usePalette, type KeyHint } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createContext, createSignal, For, onCleanup, Show, useContext, type Accessor } from "solid-js"

/** What the shared keys mean on the current tab, or in a picker shown over it. */
export interface TabHandlers {
  /** ↑/↓ and j/k. */
  move(by: number): void
  /** enter, and space outside the box. */
  activate(): void
  /** ←/→ and h/l, for values to change (Settings). */
  adjust?(direction: 1 | -1): void
  /** f, for a picker that narrows the tab; the box is cleared first. */
  pick?(): void
  /** The step esc takes once the box is left and the search cleared, before the dialog closes. */
  back?(): { label: string; run(): void } | undefined
  /** Shown before the box's text, such as the feed the list is narrowed to. */
  prefix?(): string | undefined
  placeholder?(): string | undefined
}

export interface Tab {
  label: string
  /** The box's placeholder on this tab. */
  placeholder: string
  render(): JSX.Element
}

export interface TabContext {
  height: Accessor<number>
  width: Accessor<number>
  query: Accessor<string>
  typing: Accessor<boolean>
  /** Registers the keys' meaning until the calling component unmounts or another registers. */
  handle(handlers: TabHandlers): void
  /** Clears the box and returns the keyboard to the list. */
  reset(): void
  /** The dialog's command ID for a shared key, e.g. "activate". */
  command(name: string): string
  /** Shared navigation, shown first on every tab. */
  navigation: readonly KeyHint[]
}

const TabContext = createContext<TabContext>()

export function useTab(): TabContext {
  const context = useContext(TabContext)
  if (!context) throw new Error("useTab must be used inside a TabbedDialog")
  return context
}

/**
 * Tab pills, one search box shared by every tab, and the tab's content. Commands are `<prefix>.<name>`:
 * close, next, previous, down, up, adjust.next, adjust.previous, activate, pick, search, and refresh.
 */
export function TabbedDialog(props: { prefix: string; tabs: readonly Tab[]; refreshing: boolean; refresh(): void }) {
  const api = usePlugin()
  const palette = usePalette()
  const dimensions = useTerminalDimensions()
  const [tab, setTab] = createSignal(0)
  const [typing, setTyping] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [width, setWidth] = createSignal(80)
  const [handlers, setHandlers] = createSignal<TabHandlers>()
  const command = (name: string) => `${props.prefix}.${name}`
  const reset = () => { setTyping(false); setQuery("") }
  const switchTab = (by: number) => { reset(); setTab((value) => (value + by + props.tabs.length) % props.tabs.length) }
  const idle = () => !typing()
  const back = () => handlers()?.back?.()

  useDialogCommands(api, () => [
    // Each Escape undoes one thing: typing, the search, the tab's own step back, then the dialog.
    { id: command("close"), bind: "escape", run: () => {
      if (typing()) setTyping(false)
      else if (query()) setQuery("")
      else { const step = back(); if (step) step.run(); else api.ui.dialog.clear() }
    } },
    { id: command("next"), bind: "tab", run: () => switchTab(1) },
    { id: command("previous"), bind: "shift+tab", run: () => switchTab(-1) },
    // Up/down stay live while typing, so results can be browsed without leaving the box.
    { id: command("down"), bind: "down", run: () => handlers()?.move(1) },
    { id: command("up"), bind: "up", run: () => handlers()?.move(-1) },
    { id: command("down.vi"), bind: "j", enabled: idle, run: () => handlers()?.move(1) },
    { id: command("up.vi"), bind: "k", enabled: idle, run: () => handlers()?.move(-1) },
    // Left/right move the text cursor while typing.
    { id: command("adjust.next"), bind: "right,l", enabled: idle, run: () => handlers()?.adjust?.(1) },
    { id: command("adjust.previous"), bind: "left,h", enabled: idle, run: () => handlers()?.adjust?.(-1) },
    // While typing, the box's own submit handles enter, and space is text.
    { id: command("activate"), bind: "return,space", enabled: idle, run: () => handlers()?.activate() },
    { id: command("pick"), bind: "f", enabled: () => idle() && !!handlers()?.pick, run: () => { reset(); handlers()?.pick?.() } },
    { id: command("search"), bind: "/", enabled: idle, run: () => { setTyping(true) } },
    { id: command("refresh"), bind: "r", enabled: idle, run: () => props.refresh() },
  ])

  const escLabel = () => typing() ? "done" : query() ? "clear search" : back()?.label ?? "close"
  const placeholder = () => handlers()?.placeholder?.() ?? props.tabs[tab()]!.placeholder
  const context: TabContext = {
    height: () => Math.max(6, Math.min(32, dimensions().height - 11)),
    width: () => width() - 4,
    query, typing, reset, command,
    // A view that registers nothing (an empty state) must not inherit keys from one that unmounted.
    handle: (next) => {
      setHandlers(() => next)
      onCleanup(() => setHandlers((current) => current === next ? undefined : current))
    },
    navigation: [
      { key: "tab/shift+tab", label: "tabs", command: command("next") },
      { key: "↑/↓ j/k", label: "move", command: command("down") },
    ],
  }
  return (
    <box width="100%" flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} backgroundColor={palette.background}
      onSizeChange={function () { setWidth(this.width) }}>
      <box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} paddingBottom={1}>
        <box flexDirection="row" gap={1}>
          <For each={props.tabs}>{(entry, index) => (
            <box border borderColor={index() === tab() ? palette.value : palette.border} paddingLeft={1} paddingRight={1}
              onMouseDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); switchTab(index() - tab()) }}>
              <text fg={index() === tab() ? palette.value : palette.muted}>{entry.label}</text>
            </box>
          )}</For>
        </box>
        <box flexDirection="row">
          <Show when={props.refreshing}><text fg={palette.muted}>refreshing  </text></Show>
          <KeyHints items={[{ key: "esc", label: escLabel(), command: command("close") }]} />
        </box>
      </box>
      {/* One box in one place on every tab; only its meaning changes. */}
      <Card compact>
        <box flexDirection="row" minWidth={0}>
          <Show when={handlers()?.prefix?.()}>
            {(prefix) => <text wrapMode="none" flexShrink={0} fg={palette.value}>{prefix()} › </text>}
          </Show>
          <Show when={typing()} fallback={
            <text wrapMode="none" flexGrow={1} minWidth={0} fg={palette.muted}>
              <span style={{ fg: palette.text }}>/</span> {query() ? <span style={{ fg: palette.value }}>{query()}</span> : placeholder()}
            </text>
          }>
            <input focused flexGrow={1} value={query()} placeholder={placeholder()} onInput={setQuery} onSubmit={() => handlers()?.activate()}
              textColor={palette.text} focusedTextColor={palette.text} placeholderColor={palette.muted} />
          </Show>
        </box>
      </Card>
      <box paddingTop={1} flexDirection="column" minWidth={0}>
        <TabContext.Provider value={context}>
          <For each={props.tabs}>{(entry, index) => <Show when={index() === tab()}>{entry.render()}</Show>}</For>
        </TabContext.Provider>
      </box>
    </box>
  )
}

/** Lines the key hints may wrap to; reserved on every tab so wrapping never changes the dialog's height. */
const HINT_LINES = 2

/** Every tab and picker share one height: fixed content, then a fixed footer of key hints. */
export function TabFrame(props: { hints: readonly KeyHint[]; children: JSX.Element }) {
  const tab = useTab()
  return (
    <box flexDirection="column" minWidth={0}>
      <box height={tab.height()} flexDirection="column" minWidth={0} overflow="hidden">{props.children}</box>
      <box height={HINT_LINES + 1} paddingTop={1} minWidth={0} overflow="hidden"><KeyHints items={props.hints} /></box>
    </box>
  )
}
