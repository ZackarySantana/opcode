/** @jsxImportSource @opentui/solid */

import type { JSX } from "@opentui/solid/jsx-runtime"
import { usePalette } from "./palette"

export { ThemeSurface, usePalette } from "./palette"
export { cellWidth, shorten, useText } from "./text"
export { Card, CenterEmpty, FilterChip, KeyHints, Page, StatCard } from "./layout"
export type { CardProps, CenterEmptyProps, FilterChipProps, KeyHint, KeyHintsProps, PageProps, StatCardProps } from "./layout"

export interface SectionProps {
  title: string
  children: JSX.Element
}

export function Section(props: SectionProps) {
  const palette = usePalette()
  return (
    <box flexDirection="column" minWidth={0} gap={1}>
      <text fg={palette.text}><b>{props.title}</b></text>
      <box flexDirection="column" minWidth={0}>{props.children}</box>
    </box>
  )
}
