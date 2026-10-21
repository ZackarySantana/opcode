import type { Context, KeymapCommand, Route } from "@opencode/plugin/tui/context"
import { createComputed, createSignal, onCleanup } from "solid-js"
import { unwrap } from "solid-js/store"

export type ScreenIdentity = { id: string; name: string; mode: string }

export function ownsScreen(route: Route, screen: Pick<ScreenIdentity, "id" | "name">): boolean {
  return route.type === "plugin" && route.id === screen.id && route.name === screen.name
}

/** Copy mutable route containers, retaining callbacks and opaque handles by identity. */
function snapshotData(value: unknown, copies = new WeakMap<object, object>()): unknown {
  const raw = unwrap(value)
  if (raw === null || typeof raw !== "object") return raw
  const prototype = Object.getPrototypeOf(raw)
  if (!Array.isArray(raw) && prototype !== Object.prototype && prototype !== null) return raw
  const previous = copies.get(raw)
  if (previous) return previous
  const result: object = Array.isArray(raw) ? new Array(raw.length) : Object.create(prototype)
  copies.set(raw, result)
  for (const [key, child] of Object.entries(raw)) {
    Object.defineProperty(result, key, { value: snapshotData(child, copies), enumerable: true, configurable: true, writable: true })
  }
  return result
}

/** The host exposes a live store proxy: never retain it as a return destination. */
export function snapshotRoute(route: Route): Route {
  if (route.type === "home") return { type: "home" }
  if (route.type === "session") return { type: "session", sessionID: route.sessionID }
  return { type: "plugin", id: route.id, name: route.name, data: route.data === undefined ? undefined : snapshotData(route.data) as Record<string, unknown> }
}

/** Route keyboard scope; its lifetime follows the mounted view. */
export function useInputScope(api: Context, mode: string) {
  const leave = api.keymap.mode.push(mode)
  onCleanup(leave)
}

/** Native dialogs already own their mode. Register inside the dialog, not in a competing mode. */
export function useDialogCommands(api: Context, commands: () => readonly KeymapCommand[]) {
  api.keymap.layer(() => ({ mode: "global", priority: 100, commands: commands() }))
}

/** Shared route ownership, return navigation, and cancellation of obsolete interactions. */
export function createScreen(api: Context, identity: ScreenIdentity) {
  const [previous, setPrevious] = createSignal<Route>({ type: "home" })
  let disposed = false
  let generation = 0
  let wasActive = false
  const owns = (route = api.ui.router.current()) => ownsScreen(route, identity)
  const active = () => !disposed && owns()
  const invalidate = () => { generation++ }
  createComputed(() => {
    const now = owns()
    if (now !== wasActive) { wasActive = now; invalidate() }
  })
  const navigate = (data?: Record<string, unknown>) => {
    if (disposed) return false
    invalidate()
    api.ui.router.navigate({ type: "plugin", id: identity.id, name: identity.name, data })
    return true
  }
  const close = () => {
    if (!active()) return false
    invalidate()
    api.ui.router.navigate(previous())
    return true
  }
  return {
    ...identity,
    owns,
    active,
    previous,
    invalidate,
    open(data?: Record<string, unknown>) {
      if (disposed) return false
      if (!owns()) setPrevious(snapshotRoute(api.ui.router.current()))
      return navigate(data)
    },
    update(data?: Record<string, unknown>) {
      return active() && navigate(data)
    },
    close,
    /** A new interaction supersedes earlier dialogs, and departure/re-entry invalidates it. */
    interaction() {
      const captured = ++generation
      return () => active() && captured === generation
    },
    mount() {
      useInputScope(api, identity.mode)
      onCleanup(invalidate)
    },
    commands(factory: () => readonly KeymapCommand[]) {
      api.keymap.layer(() => ({ mode: identity.mode, enabled: active, commands: factory() }))
    },
    dispose() {
      if (disposed) return
      close()
      disposed = true
      invalidate()
    },
  }
}

export type Screen = ReturnType<typeof createScreen>
