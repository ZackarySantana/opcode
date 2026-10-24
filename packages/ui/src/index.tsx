/** @jsxImportSource @opentui/solid */

import type { JSX } from "@opentui/solid/jsx-runtime"
import { children as resolve, Show } from "solid-js"
import { usePalette } from "./palette"

export { ThemeSurface, usePalette } from "./palette"
export { cellWidth, shorten, useText } from "./text"
export { Card, CenterEmpty, FilterChip, KeyHints, Page, StatCard } from "./layout"
export type { CardProps, CenterEmptyProps, FilterChipProps, KeyHint, KeyHintsProps, PageProps, StatCardProps } from "./layout"

export interface SectionProps {
  title: string
  /** Muted text beside the title, such as a refresh countdown. */
  detail?: string
  children?: JSX.Element
}

export function Section(props: SectionProps) {
  const palette = usePalette()
  // With nothing to show, the section is just its title line.
  const content = resolve(() => props.children)
  return (
    <box flexDirection="column" minWidth={0} gap={1}>
      <text wrapMode="none" fg={palette.text}><b>{props.title}</b><Show when={props.detail}>{(detail) => <span style={{ fg: palette.muted }}>{` ${detail()}`}</span>}</Show></text>
      <Show when={content.toArray().length}><box flexDirection="column" minWidth={0}>{content()}</box></Show>
    </box>
  )
}
