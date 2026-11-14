/** @jsxImportSource @opentui/solid */

import { afterEach, expect, test } from "bun:test"
import { mockTheme } from "@opcode/ui/test-support/host"
import type { SessionMessageInfo } from "@opencode/client"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, DialogConfirmOptions, DialogSelectOptions, KeymapCommand, KeymapLayer, Route } from "@opencode/plugin/tui/context"
import { CliRenderEvents } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { EventEmitter } from "node:events"
import { createRoot, createSignal, onCleanup, Show } from "solid-js"
import { SAVE_LEAD } from "../src/domain"
import type { SnippetEntry } from "../src/service"
import plugin from "../src/tui"

const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const entry = (scope: "global" | "project", name: string, body: string, extra: Partial<SnippetEntry> = {}): SnippetEntry =>
  ({ scope, name, path: `/${scope}/${name}.md`, aliases: [], body, overridden: false, conflict: false, expanded: body, problems: [], breaks: [], ...extra })

async function until(check: () => unknown) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBeTruthy()
}

const messages = [
  { type: "user", id: "m1", time: { created: 1 }, text: "Summarize the plan" },
  { type: "assistant", id: "m2", time: { created: 2 }, content: [
    { type: "reasoning", text: "Thinking it over" },
    { type: "text", text: "Step one, then step two." },
  ] },
] as unknown as SessionMessageInfo[]

/**
 * The plugin over a host whose dialogs replace one another, and whose prompt accepts pastes only with no dialog open.
 */
async function harness(route: Route, options: { agentTools?: boolean } = {}) {
  let rows = [
    entry("global", "review", "GLOBAL REVIEW", { overridden: true }),
    entry("project", "later", "Loses to a skill", { conflict: true }),
    entry("project", "review", "Review the current changes\nfor correctness.", { description: "Review the diff", aliases: ["rv"], breaks: ["ticket"] }),
    entry("global", "ticket", "Do it, then @review and @gone", { expanded: "Do it, then GLOBAL REVIEW and @gone", problems: ["@gone is not a snippet."] }),
  ]
  const [dialog, setDialog] = createSignal<{ render: () => JSX.Element; close?: () => void }>()
  const layers = new Set<() => KeymapLayer>()
  const pastes: string[] = []
  const toasts: string[] = []
  const removed: unknown[] = []
  const saved: unknown[] = []
  const prompts: unknown[] = []
  const confirms: DialogConfirmOptions[] = []
  const answers: boolean[] = []
  const failures: string[] = []
  const selects: DialogSelectOptions<unknown>[] = []
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
    data: {
      on: () => () => {},
      session: { message: { list: () => messages, sync: async () => {} } },
    },
    client: {
      rpc: () => ({
        list: async () => ({ snippets: rows, agentTools: options.agentTools ?? true }),
        save: async (input: { name: string; scope: "global" | "project"; fields: { body: string } }) => {
          const failure = failures.shift()
          if (failure) throw new Error(failure)
          saved.push(input)
          rows = [...rows, entry(input.scope, input.name, input.fields.body)]
          return { path: `/${input.scope}/${input.name}.md`, breaks: [] }
        },
        remove: async (input: { name: string; scope: string }) => {
          removed.push(input)
          rows = rows.filter((row) => row.name !== input.name || row.scope !== input.scope)
          return { removed: true }
        },
      }),
      session: { prompt: async (input: unknown) => { prompts.push(input) } },
    },
    ui: {
      router: { current: () => route, navigate: (next: Route) => { route = next } },
      toast: { show: (toast: { message: string }) => toasts.push(toast.message) },
      dialog: {
        show: (render: () => JSX.Element, close?: () => void) => { dialog()?.close?.(); setDialog({ render, close }) },
        set() {},
        clear,
        confirm: async (input: DialogConfirmOptions) => { clear(); confirms.push(input); return answers.shift() },
        // Picks the first option offered.
        select: async (input: DialogSelectOptions<unknown>) => { clear(); selects.push(input); return input.options[0]?.value },
      },
    },
    keymap: {
      layer: (factory: () => KeymapLayer) => { layers.add(factory); onCleanup(() => layers.delete(factory)) },
      commands: () => dialog() ? [] : [{ id: "prompt.paste", run() {} }],
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
  const dispatch = (id: string, input?: string) => [...layers].map((layer) => layer()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .flatMap((layer) => (layer.commands ?? []) as KeymapCommand[])
    .find((command) => command.id === `opcode-snippets.${id}` && (typeof command.enabled === "function" ? command.enabled() : command.enabled ?? true))?.run(input)
  const frame = (match: (frame: string) => boolean) => view.waitForFrame(match)
  return {
    dispatch, frame, pastes, toasts, removed, saved, prompts, confirms, answers, failures, selects,
    open: () => dialog() !== undefined,
    route: () => route,
    /** Types into the focused editor field. */
    type: async (text: string) => { await view.mockInput.typeText(text); await view.renderOnce() },
    erase: async (count: number) => { for (let index = 0; index < count; index++) view.mockInput.pressBackspace(); await view.renderOnce() },
    newline: async () => { view.mockInput.pressEnter(); await view.renderOnce() },
    /** Moves the editor's focus forward by `count` fields. */
    next: async (count = 1) => { for (let index = 0; index < count; index++) dispatch("editor.next"); await view.renderOnce() },
  }
}

test("/snippets lists project snippets before global ones and previews the outlined one", async () => {
  const h = await harness({ type: "session", sessionID: "work" })
  await h.dispatch("open")
  const listed = await h.frame((frame) => frame.includes("GLOBAL") && frame.includes("/project/later.md"))
  expect(listed).toMatch(/PROJECT[\s\S]*@later\s+skill conflict[\s\S]*@review[\s\S]*GLOBAL[\s\S]*@review\s+overridden[\s\S]*@ticket\s+broken reference/)
  expect(listed).toMatch(/Skill conflict: another skill named later/)

  // The preview shows what @name attaches, with references expanded, and can show the text as written.
  for (let index = 0; index < 3; index++) h.dispatch("down")
  const preview = await h.frame((frame) => frame.includes("/global/ticket.md"))
  expect(preview).toMatch(/Broken reference: @gone is not a snippet\./)
  expect(preview).toMatch(/Do it, then GLOBAL REVIEW and @gone/)
  h.dispatch("raw")
  expect(await h.frame((frame) => frame.includes("RAW TEXT"))).toMatch(/Do it, then @review and @gone/)

  h.dispatch("up")
  h.dispatch("up")
  expect(await h.frame((frame) => frame.includes("/project/review.md"))).toMatch(/Used by: @ticket/)
})

test("enter closes /snippets and inserts @name into the prompt it was opened over", async () => {
  const h = await harness({ type: "session", sessionID: "work" })
  await h.dispatch("open")
  await h.frame((frame) => frame.includes("@later"))

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

test("d deletes only after a confirmation that names the file and the snippets left with a broken reference", async () => {
  const h = await harness({ type: "session", sessionID: "work" })
  await h.dispatch("open")
  await h.frame((frame) => frame.includes("@later"))

  // The outlined snippet survives the confirmation replacing the list.
  h.dispatch("down")
  h.answers.push(false, true)
  h.dispatch("delete")
  await until(h.open)
  expect(h.removed).toEqual([])
  expect(h.confirms[0]?.message).toMatch(/\/project\/review\.md[\s\S]*@ticket will keep @review as typed/)
  h.dispatch("delete")
  await until(() => h.removed.length)
  expect(h.removed).toEqual([{ name: "review", scope: "project" }])
  expect(h.open()).toBe(true)
  await h.frame((frame) => frame.includes("@later") && !frame.includes("Review the diff"))
})

test("n writes a new snippet in the editor and returns to the list focused on it", async () => {
  const h = await harness({ type: "home" })
  await h.dispatch("open")
  await h.frame((frame) => frame.includes("@later"))
  h.dispatch("new")
  await h.frame((frame) => frame.includes("New snippet"))

  await h.type("greet")
  await h.next()
  h.dispatch("editor.scope")
  await h.next()
  await h.type("Say hello")
  await h.next()
  await h.type("hi, @hello")
  await h.next()
  await h.type("Hello")
  await h.newline()
  await h.type("there")
  await h.dispatch("editor.save")
  await until(() => h.saved.length)

  expect(h.saved).toEqual([{ name: "greet", scope: "project", fields: { description: "Say hello", aliases: ["hi", "hello"], body: "Hello\nthere" } }])
  expect(h.toasts).toContain("Saved @greet.")
  expect(h.open()).toBe(true)
  await h.frame((frame) => !frame.includes("New snippet") && frame.includes("/project/greet.md"))
})

test("e edits the outlined snippet, renaming it through the original's key; a failed save keeps the editor open", async () => {
  const h = await harness({ type: "session", sessionID: "work" })
  await h.dispatch("open")
  await h.frame((frame) => frame.includes("@later"))
  h.dispatch("down")
  h.dispatch("edit")
  await h.frame((frame) => frame.includes("Edit @review"))

  await h.erase("review".length)
  await h.type("audit")
  h.failures.push("There is already a project snippet named audit.")
  await h.dispatch("editor.save")
  await h.frame((frame) => frame.includes("There is already a project snippet named audit."))
  expect(h.saved).toEqual([])

  // Editing clears the error; the next save goes through.
  await h.type("s")
  await h.frame((frame) => frame.includes("Edit @review") && !frame.includes("There is already"))
  await h.dispatch("editor.save")
  await until(() => h.saved.length)
  expect(h.saved).toEqual([{
    name: "audits", scope: "project", from: { name: "review", scope: "project" },
    fields: { description: "Review the diff", aliases: ["rv"], body: "Review the current changes\nfor correctness." },
  }])
  await h.frame((frame) => frame.includes("/project/audits.md"))
})

test("y duplicates the outlined snippet under a new name, without its aliases", async () => {
  const h = await harness({ type: "home" })
  await h.dispatch("open")
  await h.frame((frame) => frame.includes("@later"))
  h.dispatch("down")
  h.dispatch("duplicate")
  await h.frame((frame) => frame.includes("New snippet") && frame.includes("review-copy"))
  await h.dispatch("editor.save")
  await until(() => h.saved.length)
  expect(h.saved).toEqual([{ name: "review-copy", scope: "project", fields: { description: "Review the diff", aliases: [], body: "Review the current changes\nfor correctness." } }])
})

test("esc in a changed editor asks before discarding, and keeps the draft when the answer is no", async () => {
  const h = await harness({ type: "home" })
  await h.dispatch("open", "new")
  await h.frame((frame) => frame.includes("New snippet"))
  await h.type("draft")
  h.answers.push(false, true)
  await h.dispatch("editor.cancel")
  expect(h.confirms.map((confirm) => confirm.title)).toEqual(["Discard changes?"])
  await h.frame((frame) => frame.includes("New snippet") && frame.includes("draft"))

  // Opened on its own, the editor closes rather than returning to a list.
  await h.dispatch("editor.cancel")
  expect(h.open()).toBe(false)
  expect(h.saved).toEqual([])
})

test("m starts a snippet from one of the session's messages, newest first, text only", async () => {
  const h = await harness({ type: "session", sessionID: "work" })
  await h.dispatch("open")
  await h.frame((frame) => frame.includes("@later"))
  await h.dispatch("message")
  expect(h.selects[0]?.options.map((option) => [option.description, option.value])).toEqual([
    ["Assistant", "Step one, then step two."],
    ["You", "Summarize the plan"],
  ])
  await h.frame((frame) => frame.includes("New snippet") && frame.includes("Step one, then step two."))
  await h.type("steps")
  await h.dispatch("editor.save")
  await until(() => h.saved.length)
  expect(h.saved).toEqual([{ name: "steps", scope: "global", fields: { aliases: [], body: "Step one, then step two." } }])
})

test("Save Message as Snippet needs a session", async () => {
  const h = await harness({ type: "home" })
  await h.dispatch("save-message")
  expect(h.toasts).toEqual([expect.stringMatching(/Open a session/)])
  expect(h.selects).toEqual([])
  expect(h.open()).toBe(false)
})

test("/snippets save asks the current session's agent, or leaves the request in its prompt to finish", async () => {
  const h = await harness({ type: "session", sessionID: "work" })
  await h.dispatch("open", "save the review checklist above")
  expect(h.prompts).toEqual([{ sessionID: "work", text: `${SAVE_LEAD}the review checklist above` }])
  expect(h.pastes).toEqual([])

  await h.dispatch("open", "save")
  expect(h.pastes).toEqual([SAVE_LEAD])
  expect(h.prompts).toHaveLength(1)
  expect(h.route()).toEqual({ type: "session", sessionID: "work" })
})

test("/snippets save says so when the agent's snippet tools are off", async () => {
  const h = await harness({ type: "session", sessionID: "work" }, { agentTools: false })
  await h.dispatch("open", "save this")
  expect(h.toasts).toEqual([expect.stringMatching(/agentTools/)])
  expect(h.prompts).toEqual([])
  expect(h.pastes).toEqual([])
})
