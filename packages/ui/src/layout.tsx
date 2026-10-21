/** @jsxImportSource @opentui/solid */

import { usePlugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { For, Show } from "solid-js"
import { usePalette } from "./palette"

export interface PageProps {
  title: string
  subtitle?: string
  actions?: JSX.Element
  filters?: JSX.Element
  footer?: JSX.Element
  children: JSX.Element
}

export interface CardProps {
  title?: string
  children: JSX.Element
  grow?: boolean
  minHeight?: number
  compact?: boolean
}

export interface StatCardProps {
  label: string
  value: string | number
  detail?: string
  compact?: boolean
}

export interface FilterChipProps {
  label: string
  value: string | number
}

export interface KeyHint {
  key: string
  label: string
  command?: string
  onTrigger?: () => void
}

export interface KeyHintsProps {
  items: readonly KeyHint[]
}

export interface CenterEmptyProps {
  title: string
  description?: string
}

/** Fill the available host surface, keeping chrome outside the shrinking content area. */
export function Page(props: PageProps) {
  const palette = usePalette()
  return (
    <box width="100%" height="100%" minWidth={0} minHeight={0} flexDirection="column"
      paddingX={2} paddingY={1} gap={1} backgroundColor={palette.background}>
      <box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" gap={1} flexShrink={0} minWidth={0}>
        <text fg={palette.accent} minWidth={0} flexShrink={1}>
          <b>{props.title}</b>
          <Show when={props.subtitle}><span style={{ fg: palette.muted }}> {props.subtitle}</span></Show>
        </text>
        <Show when={props.actions}>
          <box minWidth={0} maxWidth="100%" flexShrink={1}>{props.actions}</box>
        </Show>
      </box>
      <Show when={props.filters}>
        <box flexDirection="row" flexWrap="wrap" alignItems="center" gap={1} flexShrink={0} minWidth={0}>{props.filters}</box>
      </Show>
      <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} minHeight={0} gap={1} overflow="hidden">
        {props.children}
      </box>
      <Show when={props.footer}>
        <box flexDirection="row" justifyContent="space-between" minWidth={0} flexShrink={0}>{props.footer}</box>
      </Show>
    </box>
  )
}

/** Raised, bordered content surface. The parent chooses row/column composition. */
export function Card(props: CardProps) {
  const palette = usePalette()
  return (
    <box flexDirection="column" flexGrow={props.grow ? 1 : 0} minWidth={0} minHeight={props.minHeight ?? 0}
      border borderColor={palette.border} backgroundColor={palette.panel}
      paddingX={1} paddingY={props.compact ? 0 : 1} overflow="hidden">
      <Show when={props.title}>
        <text fg={palette.accent} flexShrink={0} marginBottom={props.compact ? 0 : 1}><b>{props.title}</b></text>
      </Show>
      {props.children}
    </box>
  )
}

/** A vertically stacked statistic, not a stretched label/value row. */
export function StatCard(props: StatCardProps) {
  const palette = usePalette()
  return (
    <Card grow compact={props.compact}>
      <text fg={palette.accent}>{props.label.toUpperCase()}</text>
      <text fg={palette.value}><b>{String(props.value)}</b></text>
      <Show when={props.detail}><text fg={palette.muted}>{props.detail}</text></Show>
    </Card>
  )
}

export function FilterChip(props: FilterChipProps) {
  const palette = usePalette()
  return (
    <box border borderColor={palette.border} paddingX={1} height={3} minWidth={0} maxWidth="100%" overflow="hidden">
      <text wrapMode="none" minWidth={0} fg={palette.accent}>
        {props.label}: <span style={{ fg: palette.text }}>{String(props.value)}</span>
      </text>
    </box>
  )
}

/** Optional actions reuse the same registered commands as keyboard dispatch. */
export function KeyHints(props: KeyHintsProps) {
  const context = usePlugin()
  const palette = usePalette()
  return (
    <box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={0} minWidth={0}>
      <For each={props.items}>{(item) => (
        <box minWidth={0} onMouseDown={item.command || item.onTrigger ? (event) => {
          if (event.button !== 0) return
          event.stopPropagation()
          if (item.command) context.keymap.dispatch(item.command)
          else item.onTrigger?.()
        } : undefined}>
          <text fg={palette.muted} wrapMode="word"><span style={{ fg: palette.value }}>{item.key}</span> {item.label}</text>
        </box>
      )}</For>
    </box>
  )
}

export function CenterEmpty(props: CenterEmptyProps) {
  const palette = usePalette()
  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} alignItems="center" justifyContent="center" gap={1}>
      <text fg={palette.text}><b>{props.title}</b></text>
      <Show when={props.description}><text fg={palette.muted}>{props.description}</text></Show>
    </box>
  )
}
