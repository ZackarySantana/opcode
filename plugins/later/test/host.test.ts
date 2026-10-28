import { afterEach, expect, test } from "bun:test"
import type { Context, Route } from "@opencode/plugin/tui/context"
import { CliRenderEvents } from "@opentui/core"
import { EventEmitter } from "node:events"
import { closeServers, eventually, stopped } from "@opcode/core/test-support/server"
import { LaterController } from "../src/host"
import { find, laterServer, messages, read, remote } from "./fixture"

const cleanup: Array<() => void> = []
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop() })
afterEach(closeServers)

/** A controller on a fake server, with the host's dialog stack: showing a dialog closes the one it replaces. */
function harness(initial: Route = { type: "home" }) {
  const f = laterServer()
  /** Another terminal on the same server. */
  const external = remote(f.server, "/elsewhere")
  let route = initial
  let dialog: { name: string; onClose?: () => void } | undefined
  let answer: ((value: unknown) => void) | undefined
  let nextFrame = Promise.resolve()
  let pasteHook = () => {}
  let ready = true
  const pastes: string[] = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const show = (name: string, onClose?: () => void) => {
    const replaced = dialog
    dialog = { name, onClose }
    replaced?.onClose?.()
  }
  const clear = () => {
    const closed = dialog
    dialog = undefined
    closed?.onClose?.()
  }
  // Native prompts settle once: with the answer, or undefined when closed or replaced.
  const native = (value?: unknown) => new Promise((resolve) => {
    let settled = false
    const settle = (result: unknown) => { if (!settled) { settled = true; resolve(result) } }
    show("native", () => settle(undefined))
    answer = (result) => { settle(result); clear() }
    if (value !== undefined) answer(value)
  })
  const renderer = Object.assign(new EventEmitter(), {
    isDestroyed: false,
    requestRender: () => { void nextFrame.then(() => renderer.emit(CliRenderEvents.FRAME)) },
    keyInput: { processPaste: (bytes: Uint8Array) => { pasteHook(); pastes.push(new TextDecoder().decode(bytes)) } },
  })
  const api = {
    renderer,
    keymap: {
      commands: () => ready && !dialog ? [{ id: "prompt.paste" }] : [],
      mode: { current: () => dialog ? "modal" : "base" },
    },
    ui: {
      router: { current: () => route, navigate: (destination: Route) => { route = destination } },
      toast: { show: (toast: { message: string; variant?: string }) => toasts.push(toast) },
      dialog: { show: (_render: unknown, onClose?: () => void) => show("later", onClose), set: () => {}, clear, prompt: () => native(), confirm: () => native() },
    },
  }
  const host = new LaterController(api as unknown as Context, remote(f.server), () => null as never, stopped)
  cleanup.push(() => host.dispose())
  return {
    host, server: f.server, external, pastes, toasts, api,
    /** The stored list. */
    stored: () => read(f.server),
    /** Adds an item from elsewhere, and waits until this terminal shows it. */
    async add(text: string) {
      const { id } = await external.add(text)
      await eventually(() => expect(host.list().active.some((item) => item.id === id)).toBe(true))
      return id
    },
    /** The item as this terminal shows it. */
    item: (id: string) => find(host.list(), id),
    /** Waits until this terminal shows the stored list. */
    async settled() {
      const stored = await read(f.server)
      await eventually(() => expect(host.list().active).toEqual(stored.active))
      expect(host.list().completed).toEqual(stored.completed)
    },
    dialog: () => dialog?.name,
    route: () => route,
    answer: (value: unknown) => answer!(value),
    dismiss: clear,
    /** Another dialog, such as the command palette, replaces whatever is showing. */
    interrupt: () => show("other"),
    frame: (promise: Promise<void>) => { nextFrame = promise },
    ready: (value: boolean) => { ready = value },
    pasteHook: (callback: () => void) => { pasteHook = callback },
  }
}

test("add, edit, and delete prompts replace the dialog, which reopens with their result", async () => {
  const h = harness()
  h.host.open()
  let pending = h.host.add()
  expect(h.dialog()).toBe("native")
  h.answer("one")
  await pending
  expect(h.dialog()).toBe("later")
  expect(messages(await h.stored())).toEqual(["one"])
  // The answer shows at once, without waiting for the announcement.
  expect(messages(h.host.list())).toEqual(["one"])

  pending = h.host.edit(h.host.list().active[0]!)
  h.answer("edited")
  await pending
  pending = h.host.add()
  h.dismiss()
  await pending
  expect(h.dialog()).toBe("later")
  expect(messages(await h.stored())).toEqual(["edited"])

  pending = h.host.add()
  h.answer(" \n ")
  await pending
  expect(h.toasts.at(-1)).toMatchObject({ variant: "error", message: "Message cannot be empty" })

  const removing = h.host.remove(h.host.list().active[0]!)
  h.answer(true)
  expect(await removing).toBe(true)
  expect(h.dialog()).toBe("later")
  expect((await h.stored()).active).toEqual([])
})

test("agent tools turn back on only after the user confirms, and turn off at once", async () => {
  const h = harness()
  h.host.open()
  // Another terminal turned them off; changing the sidebar count here leaves them off.
  await h.external.settings({ agentTools: false })
  await h.host.updateSettings({ sidebarItems: 10 })
  expect((await h.stored()).settings).toEqual({ sidebarItems: 10, agentTools: false })
  expect(h.host.settings()).toEqual({ sidebarItems: 10, agentTools: false })

  let pending = h.host.updateSettings({ agentTools: true })
  expect(h.dialog()).toBe("native")
  h.answer(false)
  await pending
  expect((await h.stored()).settings.agentTools).toBe(false)
  pending = h.host.updateSettings({ agentTools: true })
  h.answer(true)
  await pending
  expect((await h.stored()).settings.agentTools).toBe(true)

  await h.host.updateSettings({ agentTools: false })
  expect((await h.stored()).settings.agentTools).toBe(false)
})

test("a dialog that replaces a prompt stays open, and the prompt's answer is dropped", async () => {
  const h = harness()
  h.host.open()
  const pending = h.host.add()
  h.interrupt()
  await pending
  expect(h.dialog()).toBe("other")
  expect((await h.stored()).revision).toBe(0)
})

test("prompts answered for an item that changed meanwhile never overwrite the newer content", async () => {
  const h = harness()
  const id = await h.add("original")
  h.host.open()
  const editing = h.host.edit(h.item(id))
  await h.external.edit(find(await h.stored(), id), "newer")
  h.answer("stale edit")
  await editing
  expect(find(await h.stored(), id).message).toBe("newer")
  expect(h.toasts.at(-1)?.variant).toBe("warning")
  await h.settled()
  const deleting = h.host.remove(h.item(id))
  await h.external.edit(find(await h.stored(), id), "newest")
  h.answer(true)
  expect(await deleting).toBe(false)
  expect(find(await h.stored(), id).message).toBe("newest")
  expect(h.toasts.at(-1)?.variant).toBe("warning")
})

test("completing an item deleted elsewhere never completes another, and restoring appends", async () => {
  const h = harness()
  const first = await h.add("first")
  const second = await h.add("second")
  const seen = h.item(first)
  await h.external.delete(find(await h.stored(), first))
  expect(await h.host.toggle(seen)).toBe(false)
  expect(find(await h.stored(), second).completedAt).toBeUndefined()
  expect(await h.host.toggle(h.item(second))).toBe(true)
  await h.add("third")
  expect(await h.host.toggle(h.item(second))).toBe(true)
  expect(messages(await h.stored())).toEqual(["third", "second"])
})

test("quick moves of one item each apply", async () => {
  const h = harness()
  const id = await h.add("first")
  await h.add("second")
  await h.add("third")
  const item = h.item(id)
  // Sent before either answer arrives, from the same view of the item.
  await Promise.all([h.host.move(item, 1), h.host.move(item, 1), h.host.move(item, 1)])
  expect(messages(await h.stored())).toEqual(["second", "third", "first"])
  expect(h.toasts).toEqual([])
})

test("pending prompts are dropped on unload", async () => {
  const h = harness()
  const id = await h.add("original")
  h.host.open()
  const editing = h.host.edit(h.item(id))
  h.host.dispose()
  h.answer("must not save")
  await editing
  expect(messages(await h.stored())).toEqual(["original"])
})

test.each([{ type: "home" }, { type: "session", sessionID: "session-1" }] as const)("paste closes the dialog, pastes into the %j prompt behind it, and completes", async (origin) => {
  const h = harness(origin)
  const id = await h.add("café ☕\nadd tests")
  h.host.open()
  await h.host.paste(h.item(id))
  expect(h.dialog()).toBeUndefined()
  expect(h.route()).toEqual(origin)
  expect(h.pastes).toEqual(["café ☕\nadd tests"])
  expect((await h.stored()).active).toEqual([])
  expect(h.toasts.at(-1)?.variant).toBe("success")
})

test("over another plugin's page, paste leaves the dialog and the item alone", async () => {
  const h = harness({ type: "plugin", id: "other", name: "other.page" })
  const id = await h.add("keep me")
  h.host.open()
  await h.host.paste(h.item(id))
  expect(h.dialog()).toBe("later")
  expect(h.pastes).toEqual([])
  expect(h.toasts.at(-1)?.variant).toBe("warning")
})

test("a prompt that never becomes ready keeps the item and allows another paste", async () => {
  const h = harness()
  const id = await h.add("keep me")
  h.ready(false)
  await h.host.paste(h.item(id))
  expect((await h.stored()).active).toHaveLength(1)
  expect(h.toasts.at(-1)?.variant).toBe("error")
  h.ready(true)
  await h.host.paste(h.item(id))
  expect(h.pastes).toEqual(["keep me"])
})

test("an edit elsewhere before delivery cancels the paste, but completing an unrelated item does not", async () => {
  const h = harness()
  const above = await h.add("above")
  const target = await h.add("paste me")
  let frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  let pending = h.host.paste(h.item(target))
  await h.external.edit(find(await h.stored(), target), "new text")
  await eventually(() => expect(h.item(target).message).toBe("new text"))
  frame.resolve()
  await pending
  expect(h.pastes).toEqual([])
  expect(find(await h.stored(), target)).toMatchObject({ message: "new text" })
  expect(find(await h.stored(), target).completedAt).toBeUndefined()

  frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  pending = h.host.paste(h.item(target))
  await h.external.complete(find(await h.stored(), above))
  await eventually(() => expect(h.item(above).completedAt).toBeDefined())
  frame.resolve()
  await pending
  expect(h.pastes).toEqual(["new text"])
  expect(find(await h.stored(), target).completedAt).toBeDefined()
})

test("an edit elsewhere the terminal hasn't heard of yet stops the paste's completion", async () => {
  const h = harness()
  const id = await h.add("original")
  const item = h.item(id)
  // Saved before the paste completes the item, but announced only later.
  const editing = Promise.withResolvers<void>()
  h.pasteHook(() => { void h.external.edit(item, "newer").then(() => editing.resolve()) })
  const pasting = h.host.paste(item)
  await editing.promise
  await pasting
  expect(h.pastes).toEqual(["original"])
  expect(find(await h.stored(), id)).toMatchObject({ message: "newer" })
  expect(find(await h.stored(), id).completedAt).toBeUndefined()
  expect(h.toasts.at(-1)?.variant).toBe("warning")
})

test("repeated paste while the prompt mounts delivers once", async () => {
  const h = harness()
  const item = h.item(await h.add("once"))
  const frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  const pending = h.host.paste(item)
  await h.host.paste(item)
  frame.resolve()
  await pending
  expect(h.pastes).toEqual(["once"])
})

test("unloading during a pending paste pastes and changes nothing", async () => {
  const h = harness()
  const id = await h.add("keep me")
  const frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  const pending = h.host.paste(h.item(id))
  h.host.dispose()
  await pending
  frame.resolve()
  expect(h.pastes).toEqual([])
  expect((await h.stored()).active).toHaveLength(1)
  expect(h.toasts).toEqual([])
})

test("a failed paste leaves the item active", async () => {
  const h = harness()
  const id = await h.add("original")
  h.pasteHook(() => { throw new Error("paste failed") })
  await h.host.paste(h.item(id))
  expect(h.toasts.at(-1)?.message).toBe("paste failed")
  expect(find(await h.stored(), id).completedAt).toBeUndefined()
})

test("a failure saving the completion warns that the text was already delivered", async () => {
  const h = harness()
  const id = await h.add("already pasted")
  h.pasteHook(() => { h.server.faults.set = true })
  await h.host.paste(h.item(id))
  expect(h.pastes).toEqual(["already pasted"])
  h.server.faults.set = false
  expect((await h.stored()).active).toHaveLength(1)
  expect(h.toasts.at(-1)).toMatchObject({ variant: "error" })
  expect(h.toasts.at(-1)?.message).toContain("Text was pasted")
  expect(h.toasts.at(-1)?.message).toContain("disk full")
})

test("a list that can't be read is said once, not on every retry", async () => {
  const h = harness()
  h.server.faults.get = true
  h.host.refresh()
  await eventually(() => expect(h.toasts.at(-1)?.message).toContain("can't be read right now"))
  h.host.refresh()
  h.host.refresh()
  await Bun.sleep(20)
  expect(h.toasts.filter((toast) => toast.message.includes("can't be read"))).toHaveLength(1)
})

test("unloading closes the open dialog or pending prompt once", async () => {
  const h = harness()
  h.host.open()
  h.host.dispose()
  expect(h.dialog()).toBeUndefined()
  h.interrupt()
  h.host.dispose()
  expect(h.dialog()).toBe("other")
  const asking = harness()
  asking.host.open()
  const pending = asking.host.add()
  asking.host.dispose()
  await pending
  expect(asking.dialog()).toBeUndefined()
})
