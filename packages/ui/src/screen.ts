import type { Context, KeymapCommand, Route } from "@opencode/plugin/tui/context"
import { unwrap } from "solid-js/store"

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

/** Native dialogs already own their mode. Register inside the dialog, not in a competing mode. */
export function useDialogCommands(api: Context, commands: () => readonly KeymapCommand[]) {
  api.keymap.layer(() => ({ mode: "global", priority: 100, commands: commands() }))
}
