/** @jsxImportSource @opentui/solid */

import { usePalette, useText } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import { CliRenderEvents, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import type { Found } from "./references"
import { scopes, type Mark, type ReferenceList, type Scope } from "./usages"

const scopeTitle: Record<Scope, string> = { all: "All", diff: "In diff", outside: "Outside" }
const markGlyph: Record<Mark, string> = { changed: "+", diffed: "·", outside: " " }

/** The places a symbol is used or defined, grouped by file, with what the diff may have missed. Selecting one opens it. */
export function ReferencesView(props: {
  query: "usages" | "definition"
  name: string
  found?: Found
  error?: string
  list?: ReferenceList
  scope: Scope
  selected: number
  width: number
  onSelect: (index: number) => void
}) {
  const palette = usePalette()
  const text = useText()
  const api = usePlugin()
  let scroll: ScrollBoxRenderable | undefined
  const flagged = () => {
    const list = props.list
    if (!list) return []
    return [
      list.signatureChanged && "signature changed",
      list.removed && "definition removed",
      list.unused && "nothing uses it yet",
    ].filter((flag): flag is string => !!flag)
  }
  const engine = () => {
    const found = props.found
    if (!found) return ""
    const how = `${found.engine === "lsp" ? `via ${found.server ?? "language server"}` : "text search"}${found.fallback ? ` (${found.fallback})` : ""}`
    return found.partial ? `${how}, still loading: may be incomplete` : how
  }
  // Keep the selected reference on screen.
  createEffect(on(() => props.selected, (index) => {
    const follow = () => { if (scroll && !scroll.isDestroyed) scroll.scrollChildIntoView(`ref-${index}`) }
    follow()
    api.renderer.once(CliRenderEvents.FRAME, follow)
    api.renderer.requestRender()
    onCleanup(() => { api.renderer.off(CliRenderEvents.FRAME, follow) })
  }))
  const flat = () => props.list?.listed ?? []
  const indexOf = createMemo(() => new Map(flat().map((reference, index) => [reference, index])))
  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      <text fg={palette.muted} wrapMode="none" flexShrink={0}>
        <b><span style={{ fg: palette.text }}>{props.query === "usages" ? "Usages" : "Definitions"} of {props.name}</span></b>  {engine()}
      </text>
      <Show when={props.list} fallback={<text fg={props.error ? palette.error : palette.muted} wrapMode="word">{props.error ? `! ${props.error}` : `Looking for ${props.name}...`}</text>}>
        {(list) => (
          <>
            <text fg={palette.muted} wrapMode="none" flexShrink={0}>
              {list().counts.total} {list().counts.total === 1 ? "place" : "places"} · {list().counts.inDiff} in the diff · {list().counts.outside} outside
              <Show when={flagged().length}><span style={{ fg: palette.warning }}>  ⚠ {flagged().join(" · ")}</span></Show>
            </text>
            <text wrapMode="none" flexShrink={0} fg={palette.muted}>
              <For each={scopes}>{(scope) => <span style={{ fg: scope === props.scope ? palette.text : palette.muted }}>{scope === props.scope ? `[${scopeTitle[scope]}]` : ` ${scopeTitle[scope]} `} </span>}</For>
            </text>
            <Show when={flat().length} fallback={<text fg={palette.muted} wrapMode="word">{list().counts.total ? "Nothing here in this scope. Press tab for another." : `No ${props.query === "usages" ? "usages" : "definition"} found.`}</text>}>
              <scrollbox ref={(element: ScrollBoxRenderable) => { scroll = element }} flexGrow={1} minHeight={0}>
                <For each={list().groups}>{(group) => (
                  <box flexDirection="column" minWidth={0}>
                    <text wrapMode="none" fg={palette.accent}>
                      {text.shorten(group.file, Math.max(10, props.width - 20))}<span style={{ fg: palette.muted }}>{group.touched ? "" : "  not changed by the agent"}</span>
                    </text>
                    <For each={group.references}>{(reference) => {
                      const at = indexOf().get(reference) ?? 0
                      const selected = () => at === props.selected
                      const tags = [reference.definition && "def", reference.notUpdated && "⚠ not updated?"].filter(Boolean).join("  ")
                      return (
                        <box id={`ref-${at}`} flexDirection="row" minWidth={0} backgroundColor={selected() ? palette.selectedBackground : undefined} onMouseDown={() => props.onSelect(at)}>
                          <text wrapMode="none" flexShrink={0} fg={selected() ? palette.selectedText : reference.mark === "changed" ? palette.success : palette.muted}>
                            {markGlyph[reference.mark]}{String(reference.line).padStart(5)}{"  "}
                          </text>
                          <text wrapMode="none" minWidth={0} flexGrow={1} flexShrink={1} fg={selected() ? palette.selectedText : palette.text}>{reference.text.trim()}</text>
                          <Show when={tags}><text wrapMode="none" flexShrink={0} fg={selected() ? palette.selectedText : palette.warning}>{`  ${tags}`}</text></Show>
                        </box>
                      )
                    }}</For>
                  </box>
                )}</For>
              </scrollbox>
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}
