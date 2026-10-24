import { expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { activeRoots, applyEvent, backEntry, emptyProjection, observeRoute, popHistory, pushHistory, reorder } from "../src/inbox"

const event = (type: string, data: object, created = 0, directory = "/work/alpha") => ({ type, data, created, location: { directory } }) as unknown as OpenCodeEvent
const created = (sessionID: string, parentID?: string, directory = "/work/alpha") => event("session.created", { sessionID, parentID, title: `Session ${sessionID}`, location: { directory } }, 1, directory)
const status = (sessionID: string, type: "busy" | "idle" | "retry", action?: object, at = 10) => event("session.status", { sessionID, status: type === "retry" ? { type, attempt: 1, message: "", next: 0, action } : { type } }, at)
const states = (projection: ReturnType<typeof emptyProjection>) => activeRoots(projection).map(({ id, state, agents }) => ({ id, state, agents }))

test("one row per active root: subagents roll up, requests anywhere need you, and only the root's unseen idle counts", () => {
  const projection = emptyProjection()
  for (const value of [created("root"), created("child", "root"), created("grandchild", "child")]) applyEvent(projection, value)
  expect(states(projection)).toEqual([])

  applyEvent(projection, status("root", "busy"))
  applyEvent(projection, status("grandchild", "busy"))
  expect(states(projection)).toEqual([{ id: "root", state: "working", agents: 1 }])
  applyEvent(projection, status("grandchild", "retry"))
  expect(states(projection)).toEqual([{ id: "root", state: "retrying", agents: 1 }])
  applyEvent(projection, status("grandchild", "retry", { reason: "auth", provider: "p", title: "Sign in", message: "", label: "Sign in" }))
  expect(states(projection)[0]?.state).toBe("needs-you")
  applyEvent(projection, status("grandchild", "busy"))
  applyEvent(projection, event("permission.asked", { id: "per_1", sessionID: "grandchild", action: "bash", resources: [] }))
  applyEvent(projection, event("form.created", { form: { id: "frm_1", sessionID: "child", title: "Pick", fields: [] } }))
  expect(states(projection)[0]?.state).toBe("needs-you")
  applyEvent(projection, event("permission.replied", { sessionID: "grandchild", requestID: "per_1", reply: "once" }))
  expect(states(projection)[0]?.state).toBe("needs-you")
  applyEvent(projection, event("form.cancelled", { id: "frm_1", sessionID: "child" }))
  expect(states(projection)[0]?.state).toBe("working")

  // A finished subagent is never viewed; it must not keep its root listed.
  applyEvent(projection, event("session.idle", { sessionID: "grandchild" }, 20))
  applyEvent(projection, event("session.idle", { sessionID: "root" }, 30))
  expect(states(projection)).toEqual([{ id: "root", state: "finished", agents: 0 }])
  expect(activeRoots(projection)[0]?.since).toBe(30)
  applyEvent(projection, event("session.viewed", { sessionID: "root", idle: 29 }, 31))
  expect(states(projection)).toEqual([])

  applyEvent(projection, event("session.execution.started", { sessionID: "root" }, 40))
  applyEvent(projection, status("root", "busy", undefined, 40))
  applyEvent(projection, event("session.execution.failed", { sessionID: "root", error: { type: "x", message: "boom" } }, 41))
  applyEvent(projection, event("session.idle", { sessionID: "root" }, 42))
  expect(states(projection)).toEqual([{ id: "root", state: "failed", agents: 0 }])
  applyEvent(projection, event("session.archived", { sessionID: "root" }, 43))
  expect(states(projection)).toEqual([])
})

test("a location shutdown stops its sessions without touching other locations", () => {
  const projection = emptyProjection()
  for (const value of [created("a"), created("b", undefined, "/work/beta"), status("a", "busy"), status("b", "busy")]) applyEvent(projection, value)
  applyEvent(projection, event("permission.asked", { id: "per_1", sessionID: "a", action: "bash", resources: [] }))
  applyEvent(projection, event("location.shutdown", {}, 50, "/work/alpha"))
  expect(states(projection)).toEqual([{ id: "b", state: "working", agents: 0 }])
})

test("activation order is stable while states change; new roots follow, oldest first", () => {
  const roots = (ids: string[]) => ids.map((id, index) => ({ id, state: "working" as const, agents: 0, since: index }))
  expect(reorder([], roots(["b", "a"]))).toEqual(["b", "a"])
  expect(reorder(["b", "a"], [{ id: "a", state: "needs-you", agents: 0, since: 9 }, { id: "c", state: "working", agents: 0, since: 5 }, { id: "b", state: "finished", agents: 0, since: 1 }])).toEqual(["b", "a", "c"])
  expect(reorder(["b", "a", "c"], roots(["c", "b"]))).toEqual(["b", "c"])
})

test("back history edges the plugin-level test doesn't reach: home and plugin pages", () => {
  const entry = (id: string) => ({ id, title: `Title ${id}` })
  const trail = pushHistory(pushHistory({ stack: [] }, entry("A"), "B"), entry("B"), "C")
  expect(backEntry(trail, "C")).toEqual(entry("B"))
  // Reopening the current session changes nothing.
  expect(backEntry(pushHistory(trail, entry("C"), "C"), "C")).toEqual(entry("B"))
  // Going home clears it; from home or a plugin page there is nothing to go back to.
  expect(backEntry(observeRoute(trail, "home"), "C")).toBeUndefined()
  expect(backEntry(pushHistory(trail, undefined, "D"), "D")).toBeUndefined()
  expect(popHistory(pushHistory(trail, undefined, "D")).to).toBeUndefined()
})
