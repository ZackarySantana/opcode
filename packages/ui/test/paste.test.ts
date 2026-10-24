import { expect, spyOn, test } from "bun:test"
import type { Context, KeymapCommand, Route } from "@opencode/plugin/tui/context"
import { CliRenderEvents } from "@opentui/core"
import { EventEmitter } from "node:events"
import { pasteIntoPrompt } from "../src/paste"

function harness(commands: readonly KeymapCommand[] = [{ id: "prompt.paste", run() {} }]) {
  const lifetime = new AbortController()
  let route: Route = { type: "home" }
  let reads = 0
  let unchangedChecks = 0
  const pastes: string[] = []
  const renderer = Object.assign(new EventEmitter(), {
    isDestroyed: false,
    requestRender() {},
    keyInput: { processPaste: (bytes: Uint8Array) => pastes.push(new TextDecoder().decode(bytes)) },
  })
  const api = {
    renderer,
    keymap: { commands: () => commands },
    ui: { router: { current: () => { reads++; return route }, navigate: (destination: Route) => { route = destination } } },
  } as unknown as Pick<Context, "renderer" | "keymap" | "ui">
  return {
    renderer, lifetime, pastes, reads: () => reads,
    checks: () => unchangedChecks,
    paste: (timeoutMs = 30) => pasteIntoPrompt(api, { type: "home" }, "text", () => true,
      () => { unchangedChecks++; return true }, { signal: lifetime.signal, timeoutMs }),
  }
}

test.each([
  ["missing", []],
  ["disabled", [{ id: "prompt.paste", enabled: false, run() {} }]],
  ["function-disabled", [{ id: "prompt.paste", enabled: () => false, run() {} }]],
] as const)("%s readiness is bounded and never reaches delivery", async (_label, commands) => {
  const h = harness(commands)
  const pending = h.paste()
  h.renderer.emit(CliRenderEvents.FRAME)
  expect(await pending).toBe("unavailable")
  expect(h.pastes).toEqual([])
  expect(h.checks()).toBe(0)
  expect(h.renderer.listenerCount(CliRenderEvents.FRAME)).toBe(0)
  expect(h.renderer.listenerCount(CliRenderEvents.DESTROY)).toBe(0)
})

test("cancelling a frame wait settles immediately and removes frame/destroy/timeout work", async () => {
  const h = harness()
  const schedule = globalThis.setTimeout
  let timeouts = 0
  const trackedSchedule = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    schedule(() => { timeouts++; callback(...args) }, delay)) as typeof setTimeout
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(trackedSchedule)
  let pending: ReturnType<typeof h.paste>
  try { pending = h.paste() } finally { timer.mockRestore() }
  h.lifetime.abort()
  expect(await pending).toBe("cancelled")
  expect(h.renderer.listenerCount(CliRenderEvents.FRAME)).toBe(0)
  expect(h.renderer.listenerCount(CliRenderEvents.DESTROY)).toBe(0)
  const reads = h.reads()
  h.renderer.emit(CliRenderEvents.FRAME)
  await Bun.sleep(50)
  expect(timeouts).toBe(0)
  expect(h.reads()).toBe(reads)
  expect(h.checks()).toBe(0)
  expect(h.pastes).toEqual([])
})

test("a renderer that never produces a destination frame cannot hang the operation", async () => {
  const h = harness()
  expect(await h.paste(10)).toBe("unavailable")
  expect(h.renderer.listenerCount(CliRenderEvents.FRAME)).toBe(0)
  expect(h.renderer.listenerCount(CliRenderEvents.DESTROY)).toBe(0)
  expect(h.pastes).toEqual([])
})

test("destroying the renderer cancels waiting and preserves delivery guards", async () => {
  const h = harness()
  const pending = h.paste()
  h.renderer.isDestroyed = true
  h.renderer.emit(CliRenderEvents.DESTROY)
  expect(await pending).toBe("cancelled")
  expect(h.renderer.listenerCount(CliRenderEvents.FRAME)).toBe(0)
  expect(h.renderer.listenerCount(CliRenderEvents.DESTROY)).toBe(0)
  expect(h.checks()).toBe(0)
  expect(h.pastes).toEqual([])
  expect(await h.paste()).toBe("cancelled")
})

test("a later ready frame succeeds without requiring global renderer idle", async () => {
  let enabled = false
  const h = harness([{ id: "prompt.paste", enabled: () => enabled, run() {} }])
  const pending = h.paste()
  h.renderer.emit(CliRenderEvents.FRAME)
  expect(h.pastes).toEqual([])
  enabled = true
  h.renderer.emit(CliRenderEvents.FRAME)
  expect(await pending).toBe("pasted")
  expect(h.pastes).toEqual(["text"])
  expect(h.renderer.listenerCount(CliRenderEvents.FRAME)).toBe(0)
  expect(h.renderer.listenerCount(CliRenderEvents.DESTROY)).toBe(0)
})
