/** @jsxImportSource @opentui/solid */

import { afterEach, expect, test } from "bun:test"
import { mockTheme } from "@opcode/ui/test-support/host"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, KeymapCommand, KeymapLayer, Route } from "@opencode/plugin/tui/context"
import { CliRenderEvents } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { EventEmitter } from "node:events"
import { createRoot, createSignal, onCleanup, Show } from "solid-js"
import { AUTHORING_LEAD, authoringSession } from "../src/domain"
import type { SnippetEntry } from "../src/service"
import plugin from "../src/tui"

const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const entry = (scope: "global" | "project", name: string, body: string, extra: Partial<SnippetEntry> = {}): SnippetEntry =>
  ({ scope, name, path: `/${scope}/${name}.md`, aliases: [], body, overridden: false, conflict: false, ...extra })

async function until(check: () => unknown) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBeTruthy()
}

/**
 * The plugin over a host whose dialogs replace one another, and whose prompt accepts pastes only with no dialog open.
 * With `sessions`, the Sessions plugin's navigate command is loaded.
 */
async function harness(route: Route, sessions = false) {
  let rows = [
    entry("global", "review", "GLOBAL REVIEW", { overridden: true }),
    entry("project", "later", "Loses to a skill", { conflict: true }),
    entry("project", "review", "Review the current changes\nfor correctness.", { description: "Review the diff", aliases: ["rv"] }),
  ]
  const [dialog, setDialog] = createSignal<{ render: () => JSX.Element; close?: () => void }>()
  const layers = new Set<() => KeymapLayer>()
  const pastes: string[] = []
  const toasts: string[] = []
  const removed: unknown[] = []
  const created: unknown[] = []
  const answers: boolean[] = []
  const navigated: (string | undefined)[] = []
  const renderer = Object.assign(new EventEmitter(), {
    widthMethod: "unicode", isDestroyed: false,
    requestRender: () => { setTimeout(() => renderer.emit(CliRenderEvents.FRAME)) },
    keyInput: { processPaste: (bytes: Uint8Array) => pastes.push(new TextDecoder().decode(bytes)) },
  })
  const clear = () => { dialog()?.close?.(); setDialog(undefined) }
  const api = {
    location: { directory: "/project" },
    theme: mockTheme(),
    renderer,
    data: { on: () => () => {} },
    client: {
      rpc: () => ({
        list: async () => ({ snippets: rows }),
        remove: async (input: { name: string; scope: string }) => {
          removed.push(input)
          rows = rows.filter((row) => row.name !== input.name || row.scope !== input.scope)
          return { removed: true }
        },
      }),
      session: { create: async (input: unknown) => { created.push(input); return { id: "authoring" } }, prompt: async () => {} },
    },
    ui: {
      model: { current: () => undefined },
      router: { current: () => route, navigate: (next: Route) => { route = next } },
      toast: { show: (toast: { message: string }) => toasts.push(toast.message) },
      dialog: {
        show: (render: () => JSX.Element, close?: () => void) => { dialog()?.close?.(); setDialog({ render, close }) },
        set() {},
        clear,
        confirm: async () => { clear(); return answers.shift() },
      },
    },
    keymap: {
      layer: (factory: () => KeymapLayer) => { layers.add(factory); onCleanup(() => layers.delete(factory)) },
      commands: () => [...dialog() ? [] : [{ id: "prompt.paste", run() {} }], ...sessions ? [{ id: "opcode-sessions.navigate", run() {} }] : []],
      dispatch: (id: string, input?: string) => {
        if (id !== "opcode-sessions.navigate") return
        navigated.push(input)
        route = { type: "session", sessionID: input! }
      },
    },
  } as unknown as Context
  const stop = createRoot((dispose) => {
    const unload = plugin.setup(api) as () => void
    return () => { unload(); dispose() }
  })
  const view = await testRender(() => (
    <PluginContextProvider value={api}><Show when={dialog()} keyed>{(open) => open.render()}</Show></PluginContextProvider>
  ), { width: 110, height: 44 })
  cleanups.push(stop, () => view.dispose())
  const dispatch = (id: string) => [...layers].map((layer) => layer()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .flatMap((layer) => (layer.commands ?? []) as KeymapCommand[])
    .find((command) => command.id === `opcode-snippets.${id}` && (typeof command.enabled === "function" ? command.enabled() : command.enabled ?? true))?.run()
  return {
    dispatch, pastes, toasts, removed, created, answers, navigated,
    open: () => dialog() !== undefined,
    route: () => route,
    frame: (match: (frame: string) => boolean) => view.waitForFrame(match),
  }
}

test("enter closes /snippets and inserts @name into the prompt it was opened over", async () => {
  const h = await harness({ type: "session", sessionID: "work" })
  await h.dispatch("open")
  expect(await h.frame((frame) => frame.includes("GLOBAL"))).toMatch(
    /PROJECT[\s\S]*@later\s+skill conflict[\s\S]*@review[\s\S]*@rv[\s\S]*Review the diff[\s\S]*Review the current changes for correctness\.[\s\S]*GLOBAL[\s\S]*@review\s+overridden/,
  )

  // A snippet that @name can't reach is never inserted.
  h.dispatch("activate")
  await until(() => h.toasts.length)
  expect(h.open()).toBe(true)

  h.dispatch("down")
  h.dispatch("activate")
  await until(() => h.pastes.length)
  expect(h.pastes).toEqual(["@review "])
  expect(h.open()).toBe(false)
  expect(h.route()).toEqual({ type: "session", sessionID: "work" })
})

test("over another plugin's page, /snippets keeps its list open instead of inserting", async () => {
  const h = await harness({ type: "plugin", id: "opcode-cost", name: "opcode-cost.dashboard" })
  await h.dispatch("open")
  await h.frame((frame) => frame.includes("@review"))
  h.dispatch("down")
  h.dispatch("activate")
  await until(() => h.toasts.length)
  expect(h.toasts[0]).toMatch(/home or a session/)
  expect(h.open()).toBe(true)
  expect(h.pastes).toEqual([])
})

test("d deletes only after confirmation and returns to the list; e opens an authoring session through Sessions", async () => {
  const h = await harness({ type: "session", sessionID: "work" }, true)
  await h.dispatch("open")
  await h.frame((frame) => frame.includes("@later"))

  // The outlined snippet survives the confirmation replacing the list.
  h.dispatch("down")
  h.answers.push(false, true)
  h.dispatch("delete")
  await until(h.open)
  expect(h.removed).toEqual([])
  h.dispatch("delete")
  await until(() => h.removed.length)
  expect(h.removed).toEqual([{ name: "review", scope: "project" }])
  expect(h.open()).toBe(true)
  await h.frame((frame) => frame.includes("@later") && !frame.includes("Review the diff"))

  h.dispatch("down")
  h.dispatch("edit")
  await until(() => h.pastes.length)
  expect(h.open()).toBe(false)
  expect(h.created).toMatchObject([authoringSession({ name: "review", scope: "global" })])
  // Sessions navigated, so it can offer the way back; the instructions land in that session's prompt.
  expect(h.navigated).toEqual(["authoring"])
  expect(h.route()).toEqual({ type: "session", sessionID: "authoring" })
  expect(h.pastes.at(-1)).toBe(AUTHORING_LEAD)
})
