import { usePlugin } from "@opencode/plugin/tui"
import { CliRenderEvents, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup, type Accessor, type Signal } from "solid-js"

/**
 * Focus by key, so it survives refreshes and filtering, or a remount when the key's signal is passed in.
 * Scrolls the focused child into view.
 */
export function useFocus<T>(items: Accessor<readonly T[]>, key: (item: T) => string, scroll?: () => ScrollBoxRenderable | undefined, id?: (index: number) => string,
  [focusedKey, setFocusedKey]: Signal<string | undefined> = createSignal<string>()) {
  const api = usePlugin()
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
