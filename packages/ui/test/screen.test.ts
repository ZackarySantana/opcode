import { expect, test } from "bun:test"
import type { Context, KeymapLayer, Route } from "@opencode/plugin/tui/context"
import { createRoot, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createScreen } from "../src/screen"

function fixture() {
  const [route, setRoute] = createSignal<Route>({ type: "session", sessionID: "original" })
  const modes: string[] = []
  const layers: (() => KeymapLayer)[] = []
  const api = {
    ui: { router: { current: route, navigate: setRoute } },
    keymap: {
      layer: (factory: () => KeymapLayer) => layers.push(factory),
      mode: { push: (mode: string) => { modes.push(mode); return () => { modes.splice(modes.lastIndexOf(mode), 1) } } },
    },
  } as unknown as Context
  return { api, route, setRoute, modes, layers }
}

test("screens share owner-aware return navigation without recursive reopening", () => createRoot((dispose) => {
  const host = fixture()
  const screen = createScreen(host.api, { id: "opcode-test", name: "page", mode: "test" })
  screen.open({ filter: "one" })
  screen.open({ filter: "two" })
  screen.close()
  expect(host.route()).toEqual({ type: "session", sessionID: "original" })
  const foreign = { type: "plugin", id: "another-plugin", name: "page" } as const
  host.setRoute(foreign)
  expect(screen.active()).toBe(false)
  screen.dispose()
  expect(host.route()).toEqual(foreign)
  expect(screen.open()).toBe(false)
  dispose()
}))

test("departed, superseded, and disposed interactions cannot reclaim a screen", () => createRoot((dispose) => {
  const host = fixture()
  const screen = createScreen(host.api, { id: "opcode-test", name: "page", mode: "test" })
  screen.open()
  const old = screen.interaction()
  const latest = screen.interaction()
  expect(old()).toBe(false)
  expect(latest()).toBe(true)
  host.setRoute({ type: "home" })
  screen.open()
  expect(latest()).toBe(false)
  const disposed = screen.interaction()
  screen.dispose()
  expect(disposed()).toBe(false)
  dispose()
}))

test("return routes are snapshots, not live host-store proxies", () => createRoot((dispose) => {
  const [route, setRoute] = createStore({ type: "plugin", id: "other", name: "original", data: { nested: { tab: "details" } } })
  const host = fixture()
  host.api.ui.router.current = () => route as unknown as Route
  host.api.ui.router.navigate = (next) => { setRoute(reconcile(next as never)) }
  const screen = createScreen(host.api, { id: "opcode-test", name: "page", mode: "test" })
  screen.open()
  expect(screen.previous()).toEqual({ type: "plugin", id: "other", name: "original", data: { nested: { tab: "details" } } })
  screen.open({ nested: { tab: "changed" } })
  screen.close()
  expect(route).toMatchObject({ type: "plugin", id: "other", name: "original", data: { nested: { tab: "details" } } })
  dispose()
}))

test("callback-valued route data remains usable without retaining mutable containers", () => createRoot((dispose) => {
  const host = fixture()
  let done = 0
  const onDone = () => { done++ }
  const handle = new AbortController()
  const data = { onDone, handle, tabs: [{ name: "original" }] }
  host.setRoute({ type: "plugin", id: "other", name: "page", data })
  const screen = createScreen(host.api, { id: "opcode-test", name: "page", mode: "test" })
  screen.open()
  data.tabs[0]!.name = "changed"
  screen.close()
  const back = host.route()
  if (back.type !== "plugin") throw new Error("Expected return to the foreign page")
  expect(back.data?.tabs).toEqual([{ name: "original" }])
  expect(back.data?.handle).toBe(handle)
  expect(back.data?.onDone).toBe(onDone)
  back.data?.onDone()
  expect(done).toBe(1)
  dispose()
}))

test("mounted input modes are paired and command reachability follows the owned screen", () => createRoot((dispose) => {
  const host = fixture()
  const screen = createScreen(host.api, { id: "opcode-test", name: "page", mode: "test" })
  screen.commands(() => [{ id: "test.close", bind: "escape", run: () => { screen.close() } }])
  const enabled = () => (host.layers[0]!().enabled as () => boolean)()
  expect(enabled()).toBe(false)
  screen.open()
  expect(enabled()).toBe(true)
  let unmount!: () => void
  createRoot((stop) => { unmount = stop; screen.mount() })
  expect(host.modes).toEqual(["test"])
  unmount()
  expect(host.modes).toEqual([])
  screen.close()
  expect(enabled()).toBe(false)
  dispose()
}))
