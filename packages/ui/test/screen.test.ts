import { expect, test } from "bun:test"
import type { Route } from "@opencode/plugin/tui/context"
import { createStore } from "solid-js/store"
import { snapshotRoute } from "../src/screen"

test("route snapshots don't follow later changes to the host's live route store", () => {
  const [route, setRoute] = createStore({ type: "plugin", id: "other", name: "original", data: { nested: { tab: "details" } } })
  const snapshot = snapshotRoute(route as unknown as Route)
  setRoute("data", "nested", "tab", "changed")
  expect(snapshot).toEqual({ type: "plugin", id: "other", name: "original", data: { nested: { tab: "details" } } })
})

test("route snapshots keep callbacks and opaque handles usable", () => {
  let done = 0
  const onDone = () => { done++ }
  const handle = new AbortController()
  const data = { onDone, handle, tabs: [{ name: "original" }] }
  const snapshot = snapshotRoute({ type: "plugin", id: "other", name: "page", data })
  data.tabs[0]!.name = "changed"
  if (snapshot.type !== "plugin") throw new Error("Expected a plugin route")
  expect(snapshot.data?.tabs).toEqual([{ name: "original" }])
  expect(snapshot.data?.handle).toBe(handle)
  snapshot.data?.onDone()
  expect(done).toBe(1)
})
