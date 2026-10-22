import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { Context, Destination, Route } from "@opencode/plugin/tui/context"
import { createRoot, createSignal } from "solid-js"
import { sleep } from "@opcode/core/live"
import server from "../src/index"
import tui from "../src/tui"
import { BROWSER_ROUTE } from "../src/view"
import { session, user } from "./fixtures"

test("server unload aborts initial indexing and stream, unregistering RPC before closing index", async () => {
  const started = Promise.withResolvers<void>()
  let aborted = false
  let streamAborted = false
  let disposed = false
  const context = {
    options: { database: ":memory:" }, location: { directory: "/work/alpha" },
    rpc: { register: async () => ({ dispose: async () => { disposed = true } }) },
    session: { list: async (_input: unknown, options: { signal: AbortSignal }) => {
      started.resolve()
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => { aborted = true; reject(options.signal.reason) }, { once: true }))
    } },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      try { await sleep(60_000, signal) } finally { streamAborted = signal.aborted }
    } },
  } as unknown as Plugin.Context
  const cleanup = await server.setup(context)
  await started.promise
  await cleanup?.()
  expect(aborted).toBe(true)
  expect(streamAborted).toBe(true)
  expect(disposed).toBe(true)
})

test("TUI setup pins history and RPC to one connection and leaves a foreign same-name route alone", async () => {
  const searched = Promise.withResolvers<void>()
  const calls: string[] = []
  const locations: string[] = []
  const uploaded: Array<{ server: string; text: string }> = []
  const makeClient = (server: string) => ({
    session: { list: async () => { calls.push(`${server}:sessions`); return { data: [session(server, `/connected/${server}`)], cursor: {} } } },
    message: { list: async ({ sessionID }: { sessionID: string }) => { calls.push(`${server}:messages:${sessionID}`); return { data: [user(`${server}-message`, `${server} fixture conversation`)], cursor: {} } } },
    rpc: (definition: { id: string }) => {
      calls.push(`${server}:rpc:${definition.id}`)
      const called = (method: string, options: { location: { directory: string } }) => { calls.push(`${server}:${method}`); locations.push(options.location.directory) }
      return {
        refresh: async (_input: unknown, options: { location: { directory: string } }) => { called("refresh", options); return { sessions: 1 } },
        begin: async (_input: unknown, options: { location: { directory: string } }) => { called("begin", options); return { token: server } },
        import: async (input: { messages: Array<{ text: string }> }, options: { location: { directory: string } }) => {
          called("import", options)
          uploaded.push(...input.messages.map((message) => ({ server, text: message.text })))
          return { accepted: input.messages.length }
        },
        finish: async (_input: unknown, options: { location: { directory: string } }) => { called("finish", options); return {} },
        search: async (_input: unknown, options: { location: { directory: string } }) => { called("search", options); searched.resolve(); return { rows: [], projects: [] } },
      }
    },
  })
  let connected = makeClient("A")
  const [route, setRoute] = createSignal<Route>({ type: "plugin", id: "another-plugin", name: BROWSER_ROUTE })
  const navigations: Destination[] = []
  let unregistered = false
  const api = {
    location: { directory: "/connected/A" }, get client() { return connected },
    data: { location: { command: { list: () => [] } } },
    keymap: { layer() {}, commands: () => [] },
    ui: { router: {
      register: () => () => { unregistered = true }, current: route,
      navigate: (next: Destination) => { navigations.push(next); setRoute(next as Route) },
    } },
  } as unknown as Context
  const owner = createRoot((dispose) => ({ cleanup: tui.setup(api), dispose }))
  connected = makeClient("B") // The original setup must not start reading this replacement client.
  const cleanup = await owner.cleanup
  try {
    await searched.promise
    expect(calls.every((call) => call.startsWith("A:"))).toBe(true)
    expect(calls).toContain("A:messages:A")
    expect(uploaded).toEqual([{ server: "A", text: "A fixture conversation" }])
    expect(locations.every((directory) => directory === "/connected/A")).toBe(true)
  } finally { await cleanup?.(); owner.dispose() }
  expect(unregistered).toBe(true)
  expect(navigations).toEqual([])
  expect(route()).toEqual({ type: "plugin", id: "another-plugin", name: BROWSER_ROUTE })
})
