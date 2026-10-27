/** @jsxImportSource @opentui/solid */

import { usePalette, useText } from "@opcode/ui"
import type { FileDiffInfo } from "@opencode/client"
import { createMemo, createSignal, For, Match, Switch } from "solid-js"
import type { FileList as ListStyle } from "./review"
import { fileTree } from "./tree"

/** The changed files beside the diff, as a folder tree or full paths. Clicking a file opens it; clicking a folder folds it. */
export function FileList(props: {
  files: readonly FileDiffInfo[]
  selected?: string
  style: ListStyle
  width: number
  viewed: (entry: FileDiffInfo) => boolean
  onSelect: (path: string) => void
}) {
  const palette = usePalette()
  const text = useText()
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
  return (
    <scrollbox width={props.width} flexShrink={0}>
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
                <box flexDirection="row" backgroundColor={selected() ? palette.selectedBackground : undefined} onMouseDown={() => props.onSelect(entry().file)}>
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
