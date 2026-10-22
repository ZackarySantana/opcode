import type { KeyHint } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import { CliRenderEvents, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { FeedsController } from "./host"

/** What the shared keys mean on the current tab. */
export interface TabHandlers {
  /** ↑/↓ and j/k. */
  move(by: number): void
  /** enter, and space outside the box. */
  activate(): void
  /** ←/→ and h/l, for tabs with values to change (Settings). */
  adjust?(direction: 1 | -1): void
}

export interface TabProps {
  feeds: FeedsController
  height: number
  width: number
  query: Accessor<string>
  typing: Accessor<boolean>
  handle(handlers: TabHandlers): void
  /** Clears the box and returns the keyboard to the list. */
  reset(): void
}

/** Shared navigation, shown first on every tab. */
export const navigationHints: KeyHint[] = [
  { key: "tab/shift+tab", label: "tabs", command: "opcode-feed.next" },
  { key: "↑/↓ j/k", label: "move", command: "opcode-feed.down" },
]

/** Focus by key, so it survives refreshes and filtering. Scrolls the focused child into view. */
export function useFocus<T>(items: Accessor<readonly T[]>, key: (item: T) => string, scroll?: () => ScrollBoxRenderable | undefined, id?: (index: number) => string) {
  const api = usePlugin()
  const [focusedKey, setFocusedKey] = createSignal<string>()
  const focused = createMemo(() => Math.max(0, items().findIndex((item) => key(item) === focusedKey())))
  const move = (by: number) => {
    const next = items()[Math.max(0, Math.min(items().length - 1, focused() + by))]
    if (next !== undefined) setFocusedKey(key(next))
  }
  if (scroll && id) createEffect(() => {
    const index = focused()
    items()
    const follow = () => {
      const box = scroll()
      if (!box || box.isDestroyed) return
      // The first item also reveals anything above it.
      if (index === 0) box.scrollTo(0)
      else box.scrollChildIntoView(id(index))
    }
    follow()
    api.renderer.once(CliRenderEvents.FRAME, follow)
    api.renderer.requestRender()
    onCleanup(() => { api.renderer.off(CliRenderEvents.FRAME, follow) })
  })
  return { focused, move, focus: setFocusedKey, current: () => items()[focused()] }
}


/** The rows that fit, centered on the focused one as in /context. Headings take a line but never focus. */
export function centered<T>(rows: readonly T[], focused: T | undefined, height: number): readonly T[] {
  const size = Math.max(3, height)
  const at = Math.max(0, focused === undefined ? 0 : rows.indexOf(focused))
  const start = Math.max(0, Math.min(at - Math.floor(size / 2), rows.length - size))
  return rows.slice(start, start + size)
}
