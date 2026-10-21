/** @jsxImportSource @opentui/solid */

import { usePlugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid/jsx-runtime"

export { cellWidth, shorten } from "./text"
export { Card, CenterEmpty, FilterChip, KeyHints, Page, StatCard } from "./layout"
export type { CardProps, CenterEmptyProps, FilterChipProps, KeyHint, KeyHintsProps, PageProps, StatCardProps } from "./layout"

export interface SectionProps {
  title: string
  children: JSX.Element
}

export function Section(props: SectionProps) {
  const context = usePlugin()
  return (
    <box flexDirection="column" minWidth={0} gap={1}>
      <text fg={context.theme.text.base}><b>{props.title}</b></text>
      <box flexDirection="column" minWidth={0}>{props.children}</box>
    </box>
  )
}
