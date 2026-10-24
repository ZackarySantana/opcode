import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { Context, Route } from "@opencode/plugin/tui/context"
import { CliRenderEvents } from "@opentui/core"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { tempDir } from "@opcode/ui/test-support/host"
import { LaterController } from "../src/host"
import { LaterDatabase } from "../src/sqlite"

const cleanup: Array<() => void> = []
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop() })

/** A controller over a real database, with the host's dialog stack: showing a dialog closes the one it replaces. */
function harness(initial: Route = { type: "home" }) {
  const directory = tempDir("opcode-later-host-")
  cleanup.push(directory.remove)
  const path = join(directory.path, "later.sqlite")
  const database = new LaterDatabase(path)
  const external = new LaterDatabase(path)
  cleanup.push(() => database.close(), () => external.close())
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
  const host = new LaterController(api as unknown as Context, database, () => null as never)
  cleanup.push(() => host.dispose())
  return {
    host, database, external, pastes, toasts, api, path,
    dialog: () => dialog?.name,
    route: () => route,
    navigate: (next: Route) => { route = next },
    answer: (value: unknown) => answer!(value),
    dismiss: clear,
    /** Another dialog, such as the command palette, replaces whatever is showing. */
    interrupt: () => show("other"),
    frame: (promise: Promise<void>) => { nextFrame = promise },
    ready: (value: boolean) => { ready = value },
    pasteHook: (callback: () => void) => { pasteHook = callback },
  }
}

const messages = (database: LaterDatabase) => database.snapshot().active.map((item) => item.message)

test("add, edit, and delete prompts replace the dialog, which reopens with their result", async () => {
  const h = harness()
  h.host.open()
  let pending = h.host.add()
  expect(h.dialog()).toBe("native")
  h.answer("one")
  await pending
  expect(h.dialog()).toBe("later")
  expect(messages(h.database)).toEqual(["one"])

  pending = h.host.edit(h.database.snapshot().active[0]!)
  h.answer("edited")
  await pending
  pending = h.host.add()
  h.dismiss()
  await pending
  expect(h.dialog()).toBe("later")
  expect(messages(h.database)).toEqual(["edited"])

  pending = h.host.add()
  h.answer(" \n ")
  await pending
  expect(h.toasts.at(-1)).toMatchObject({ variant: "error", message: "Message cannot be empty" })

  const removing = h.host.remove(h.database.snapshot().active[0]!)
  h.answer(true)
  expect(await removing).toBe(true)
  expect(h.dialog()).toBe("later")
  expect(h.database.snapshot().active).toEqual([])
})

test("a dialog that replaces a prompt stays open, and the prompt's answer is dropped", async () => {
  const h = harness()
  h.host.open()
  const pending = h.host.add()
  h.interrupt()
  await pending
  expect(h.dialog()).toBe("other")
  expect(h.database.revision()).toBe(0)
})

test("prompts answered for an item that changed meanwhile never overwrite the newer content", async () => {
  const h = harness()
  const id = h.database.add("original", 1)
  h.host.open()
  const editing = h.host.edit(h.database.get(id)!)
  h.external.edit(h.external.get(id)!, "newer", 2)
  h.answer("stale edit")
  await editing
  expect(h.database.get(id)?.message).toBe("newer")
  const deleting = h.host.remove(h.database.get(id)!)
  h.external.edit(h.external.get(id)!, "newest", 3)
  h.answer(true)
  expect(await deleting).toBe(false)
  expect(h.database.get(id)?.message).toBe("newest")
  expect(h.toasts.at(-1)?.variant).toBe("warning")
})

test("completing an item deleted elsewhere never completes another, and restoring appends", () => {
  const h = harness()
  const first = h.database.add("first", 1)
  const second = h.database.add("second", 2)
  h.host.refresh()
  const seen = h.host.snapshot().active[0]!
  h.external.delete(h.external.get(first)!)
  expect(h.host.toggle(seen)).toBe(false)
  expect(h.database.get(second)?.completedAt).toBeUndefined()
  expect(h.host.toggle(h.database.get(second)!)).toBe(true)
  h.database.add("third", 3)
  expect(h.host.toggle(h.database.get(second)!)).toBe(true)
  expect(messages(h.database)).toEqual(["third", "second"])
})

test("pending prompts are dropped on unload, even once the database is closed", async () => {
  const h = harness()
  h.database.add("original")
  h.host.open()
  const editing = h.host.edit(h.database.snapshot().active[0]!)
  h.host.dispose()
  h.database.close()
  h.answer("must not save")
  await editing
  expect(h.external.snapshot().active[0]?.message).toBe("original")
})

test.each([{ type: "home" }, { type: "session", sessionID: "session-1" }] as const)("paste closes the dialog, pastes into the %j prompt behind it, and completes", async (origin) => {
  const h = harness(origin)
  h.database.add("café ☕\nadd tests")
  h.host.open()
  await h.host.paste(h.database.snapshot().active[0]!)
  expect(h.dialog()).toBeUndefined()
  expect(h.route()).toEqual(origin)
  expect(h.pastes).toEqual(["café ☕\nadd tests"])
  expect(h.database.snapshot().active).toEqual([])
  expect(h.toasts.at(-1)?.variant).toBe("success")
})

test("over another plugin's page, paste leaves the dialog and the item alone", async () => {
  const h = harness({ type: "plugin", id: "other", name: "other.page" })
  h.database.add("keep me")
  h.host.open()
  await h.host.paste(h.database.snapshot().active[0]!)
  expect(h.dialog()).toBe("later")
  expect(h.pastes).toEqual([])
  expect(h.toasts.at(-1)?.variant).toBe("warning")
})

test("a prompt that never becomes ready keeps the item and allows another paste", async () => {
  const h = harness()
  h.database.add("keep me")
  h.ready(false)
  await h.host.paste(h.database.snapshot().active[0]!)
  expect(h.database.snapshot().active).toHaveLength(1)
  expect(h.toasts.at(-1)?.variant).toBe("error")
  h.ready(true)
  await h.host.paste(h.database.snapshot().active[0]!)
  expect(h.pastes).toEqual(["keep me"])
})

test("an edit elsewhere before delivery cancels the paste, but completing an unrelated item does not", async () => {
  const h = harness()
  const above = h.database.add("above", 1)
  const target = h.database.add("paste me", 2)
  let frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  let pending = h.host.paste(h.database.get(target)!)
  h.external.edit(h.external.get(target)!, "new text", 3)
  frame.resolve()
  await pending
  expect(h.pastes).toEqual([])
  expect(h.database.get(target)).toMatchObject({ message: "new text", completedAt: undefined })

  frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  pending = h.host.paste(h.database.get(target)!)
  h.external.complete(h.external.get(above)!, 4)
  frame.resolve()
  await pending
  expect(h.pastes).toEqual(["new text"])
  expect(h.database.get(target)?.completedAt).toBeDefined()
})

test("repeated paste while the prompt mounts delivers once", async () => {
  const h = harness()
  h.database.add("once")
  const item = h.database.snapshot().active[0]!
  const frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  const pending = h.host.paste(item)
  await h.host.paste(item)
  frame.resolve()
  await pending
  expect(h.pastes).toEqual(["once"])
})

test("unloading during a pending paste never touches the closed database", async () => {
  const h = harness()
  h.database.add("keep me")
  const frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  const pending = h.host.paste(h.database.snapshot().active[0]!)
  h.host.dispose()
  h.database.close()
  await pending
  frame.resolve()
  expect(h.pastes).toEqual([])
  expect(h.external.snapshot().active).toHaveLength(1)
  expect(h.toasts).toEqual([])
})

test("a failed paste or a change during delivery leaves the item active", async () => {
  const h = harness()
  const id = h.database.add("original", 1)
  h.pasteHook(() => { throw new Error("paste failed") })
  await h.host.paste(h.database.get(id)!)
  expect(h.toasts.at(-1)?.message).toBe("paste failed")
  h.pasteHook(() => { h.external.edit(h.external.get(id)!, "newer", 2) })
  await h.host.paste(h.database.get(id)!)
  expect(h.pastes).toEqual(["original"])
  expect(h.database.get(id)).toMatchObject({ message: "newer", completedAt: undefined })
  expect(h.toasts.at(-1)?.variant).toBe("warning")
})

test("a database failure after paste warns that the text was already delivered", async () => {
  const h = harness()
  h.database.add("already pasted")
  const raw = new Database(h.path)
  try {
    raw.exec("CREATE TRIGGER reject_completion BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT, 'completion failed'); END")
    await h.host.paste(h.database.snapshot().active[0]!)
    expect(h.pastes).toEqual(["already pasted"])
    expect(h.external.snapshot().active).toHaveLength(1)
    expect(h.toasts.at(-1)).toMatchObject({ variant: "error" })
    expect(h.toasts.at(-1)?.message).toContain("Text was pasted")
  } finally { raw.close() }
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
