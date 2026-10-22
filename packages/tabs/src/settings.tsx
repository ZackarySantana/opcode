/** @jsxImportSource @opentui/solid */

import { usePalette } from "@opcode/ui"
import { createMemo, For } from "solid-js"
import { TabFrame, useTab } from "./dialog"
import { useFocus } from "./focus"
import { matchesText } from "./format"

export interface SettingRow<Settings, Value = unknown> {
  id: string
  label: string
  description: string
  choices: readonly { value: Value; label: string }[]
  current(settings: Settings): Value
  update(value: Value): Partial<Settings>
}

/** Every choice stays visible; ←/→ move between them, stopping at either end. */
export function SettingsTab<Settings>(props: { rows: readonly SettingRow<Settings>[]; settings: Settings; update(change: Partial<Settings>): void }) {
  const tab = useTab()
  const palette = usePalette()
  const rows = createMemo(() => props.rows.filter((row) =>
    matchesText([row.label, row.description, ...row.choices.map((choice) => choice.label)].join(" "), tab.query())))
  const focus = useFocus(rows, (row) => row.id)
  tab.handle({
    move: focus.move,
    activate() {},
    adjust(direction) {
      const row = focus.current()
      if (!row) return
      const index = row.choices.findIndex((choice) => choice.value === row.current(props.settings))
      const next = row.choices[Math.max(0, Math.min(row.choices.length - 1, index + direction))]!
      props.update(row.update(next.value))
    },
  })
  return (
    <TabFrame hints={[...tab.navigation, { key: "←/→ h/l", label: "change", command: tab.command("adjust.next") }, { key: "/", label: "search", command: tab.command("search") }]}>
      <box flexDirection="column" minWidth={0} gap={1}>
        <For each={rows()} fallback={<text fg={palette.muted}>No matching settings.</text>}>{(row, index) => {
          const selected = () => index() === focus.focused()
          return (
            <box flexDirection="column" minWidth={0}>
              <box flexDirection="row" height={1} gap={2} backgroundColor={selected() ? palette.selectedBackground : undefined}>
                <text width={22} flexShrink={0} fg={selected() ? palette.selectedText : palette.text}>{selected() ? ">" : " "} {row.label}</text>
                <box flexDirection="row" gap={1}>
                  <For each={row.choices}>{(choice) => {
                    const active = () => choice.value === row.current(props.settings)
                    return <text fg={selected() ? palette.selectedText : active() ? palette.value : palette.muted}>{active() ? `[${choice.label}]` : ` ${choice.label} `}</text>
                  }}</For>
                </box>
              </box>
              <box paddingLeft={2}><text minWidth={0} wrapMode="word" fg={palette.muted}>{row.description}</text></box>
            </box>
          )
        }}</For>
      </box>
    </TabFrame>
  )
}
