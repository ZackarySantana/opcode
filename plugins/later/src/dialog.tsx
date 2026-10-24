/** @jsxImportSource @opentui/solid */

import { ItemList, SettingsTab, TabbedDialog, useTab, type Item, type SettingRow } from "@opcode/tabs"
import { matchesText, relative } from "@opcode/tabs/format"
import { usePalette } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import { createMemo } from "solid-js"
import { sidebarItemChoices, type LaterItem, type Settings } from "./domain"
import { PREFIX, type LaterController } from "./host"

export function LaterDialog(props: { later: LaterController }) {
  return (
    <TabbedDialog prefix={PREFIX} tab={props.later.tab} refreshing={false} refresh={() => props.later.refresh()} tabs={[
      { label: "Later", placeholder: "search items", render: () => <Items later={props.later} completed={false} /> },
      { label: "History", placeholder: "search completed items", render: () => <Items later={props.later} completed /> },
      { label: "Settings", placeholder: "search settings",
        render: () => <SettingsTab rows={settingRows} settings={props.later.settings()} update={(change) => props.later.updateSettings(change)} /> },
    ]} />
  )
}

/** Active items in order, or completed ones newest first. Enter pastes an active item and restores a completed one. */
function Items(props: { later: LaterController; completed: boolean }) {
  const api = usePlugin()
  const tab = useTab()
  const palette = usePalette()
  const later = props.later
  const selection = props.completed ? later.focus.completed : later.focus.active
  const [focused, focus] = selection
  const all = () => props.completed ? later.snapshot().completed : later.snapshot().active
  const items = createMemo(() => all().filter((item) => matchesText(item.message, tab.query())))
  // As ItemList outlines it: the first item once the focused one is gone.
  const current = () => items().find((item) => item.id === focused()) ?? items()[0]
  /** The item to outline once `item` leaves this list: the one taking its place. */
  const successor = (item: LaterItem) => {
    const index = items().indexOf(item)
    return (items()[index + 1] ?? items()[index - 1])?.id
  }
  const toggle = (item: LaterItem) => {
    const next = successor(item)
    if (later.toggle(item)) focus(next)
  }
  const idle = () => !tab.typing()
  const active = () => idle() && !props.completed
  const withCurrent = (run: (item: LaterItem) => void | Promise<void>) => () => { const item = current(); return item && run(item) }
  useDialogCommands(api, () => [
    { id: `${PREFIX}.add`, bind: "a", enabled: active, run: () => later.add() },
    { id: `${PREFIX}.edit`, bind: "e", enabled: idle, run: withCurrent((item) => later.edit(item)) },
    { id: `${PREFIX}.complete`, bind: "c", enabled: idle, run: withCurrent(toggle) },
    { id: `${PREFIX}.delete`, bind: "d", enabled: idle, run: withCurrent(async (item) => {
      const next = successor(item)
      if (await later.remove(item)) focus(next)
    }) },
    { id: `${PREFIX}.move.down`, bind: "shift+j", enabled: active, run: withCurrent((item) => later.move(item, 1)) },
    { id: `${PREFIX}.move.up`, bind: "shift+k", enabled: active, run: withCurrent((item) => later.move(item, -1)) },
  ])
  const card = (item: LaterItem): Item => props.completed
    ? { key: item.id, mark: { glyph: "✓", color: palette.success, title: palette.muted, strong: false }, head: "",
      time: `completed ${relative(item.completedAt!)}`, title: item.message }
    : { key: item.id, mark: { glyph: `${all().indexOf(item) + 1}.`, color: palette.value, title: palette.text, strong: false }, head: "",
      time: `added ${relative(item.createdAt)}`, title: item.message }
  const hints = () => props.completed ? [
    ...tab.navigation,
    { key: "enter", label: "restore", command: tab.command("activate") },
    { key: "e", label: "edit", command: `${PREFIX}.edit` },
    { key: "d", label: "delete", command: `${PREFIX}.delete` },
    { key: "/", label: "search", command: tab.command("search") },
  ] : [
    ...tab.navigation,
    { key: "enter", label: "paste", command: tab.command("activate") },
    { key: "a", label: "add", command: `${PREFIX}.add` },
    { key: "e", label: "edit", command: `${PREFIX}.edit` },
    { key: "c", label: "complete", command: `${PREFIX}.complete` },
    { key: "d", label: "delete", command: `${PREFIX}.delete` },
    { key: "J/K", label: "reorder" },
    { key: "/", label: "search", command: tab.command("search") },
  ]
  return (
    <ItemList hints={hints()} focus={selection} groups={[{ title: props.completed ? "COMPLETED" : "ACTIVE", items: items().map(card) }]}
      open={(entry) => {
        const item = items().find((item) => item.id === entry.key)
        if (item && props.completed) toggle(item)
        else if (item) void later.paste(item)
      }}
      empty={tab.query() ? "No matching items." : props.completed ? "No completed items." : "Nothing saved for later. Press a to add one."} />
  )
}

const settingRows = [
  {
    id: "sidebar", label: "Sidebar items",
    description: "How many active items the sidebar lists before pointing to /later.",
    choices: sidebarItemChoices.map((count) => ({ value: count, label: `${count}` })),
    current: (settings) => settings.sidebarItems,
    update: (sidebarItems) => ({ sidebarItems }),
  } satisfies SettingRow<Settings, number>,
] as SettingRow<Settings>[]
