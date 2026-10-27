/** @jsxImportSource @opentui/solid */

import { usePalette, useText } from "@opcode/ui"
import type { FileDiffInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import { CliRenderEvents, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Switch } from "solid-js"
import type { FileList as ListStyle } from "./review"
import { fileTree } from "./tree"

/**
 * The changed files beside the diff, or above it in a narrow panel, as a folder tree or full paths. Clicking a file
 * opens it; clicking a folder folds it. The open file stays in view.
 */
export function FileList(props: {
  files: readonly FileDiffInfo[]
  selected?: string
  style: ListStyle
  /** Columns for the names; the list fills the width it's given. */
  width: number
  /** Above the diff: at most this many rows tall. */
  maxRows?: number
  viewed: (entry: FileDiffInfo) => boolean
  onSelect: (path: string) => void
}) {
  const palette = usePalette()
  const text = useText()
  const api = usePlugin()
  let scroll: ScrollBoxRenderable | undefined
  const [closed, setClosed] = createSignal<ReadonlySet<string>>(new Set())
  const byPath = createMemo(() => new Map(props.files.map((entry) => [entry.file, entry])))
  const rows = createMemo(() => props.style === "tree"
    ? fileTree(props.files.map((entry) => entry.file), closed(), props.selected)
    : props.files.map((entry) => ({ kind: "file" as const, path: entry.file, name: entry.file, depth: 0 })))
  const fold = (path: string) => setClosed((current) => {
    const next = new Set(current)
    if (!next.delete(path)) next.add(path)
    return next
  })
  createEffect(on(() => [props.selected, rows()] as const, ([selected]) => {
    const follow = () => { if (selected && scroll && !scroll.isDestroyed) scroll.scrollChildIntoView(`file:${selected}`) }
    follow()
    api.renderer.once(CliRenderEvents.FRAME, follow)
    api.renderer.requestRender()
    onCleanup(() => { api.renderer.off(CliRenderEvents.FRAME, follow) })
  }))
  return (
    <scrollbox ref={(element: ScrollBoxRenderable) => { scroll = element }} flexShrink={0}
      {...props.maxRows === undefined ? { width: props.width } : { height: Math.max(1, Math.min(rows().length, props.maxRows)) }}>
      <For each={rows()}>{(row) => {
        const indent = "  ".repeat(row.depth)
        return (
          <Switch>
            <Match when={row.kind === "folder" && row}>{(folder) => (
              <box onMouseDown={() => fold(folder().path)}>
                <text wrapMode="none" fg={palette.muted}>{indent}{folder().open ? "▾ " : "▸ "}{text.shorten(folder().name, Math.max(4, props.width - indent.length - 2))}</text>
              </box>
            )}</Match>
            <Match when={row.kind === "file" && byPath().get(row.path)}>{(entry) => {
              const selected = () => entry().file === props.selected
              const counts = () => ` +${entry().additions} -${entry().deletions}`
              return (
                <box id={`file:${entry().file}`} flexDirection="row" backgroundColor={selected() ? palette.selectedBackground : undefined} onMouseDown={() => props.onSelect(entry().file)}>
                  <text wrapMode="none" fg={selected() ? palette.selectedText : props.viewed(entry()) ? palette.muted : palette.text}>
                    {indent}{props.viewed(entry()) ? "✓ " : "● "}{text.shorten(row.name, Math.max(4, props.width - indent.length - 2 - counts().length))}
                    <span style={{ fg: selected() ? palette.selectedText : palette.success }}> +{entry().additions}</span>
                    <span style={{ fg: selected() ? palette.selectedText : palette.error }}> -{entry().deletions}</span>
                  </text>
                </box>
              )
            }}</Match>
          </Switch>
        )
      }}</For>
    </scrollbox>
  )
}
