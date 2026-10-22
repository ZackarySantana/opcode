import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { Context, Destination, Route } from "@opencode/plugin/tui/context"
import { CliRenderEvents } from "@opentui/core"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { tempDir } from "@opcode/ui/test-support/host"
import { LaterController, MANAGER_ROUTE } from "../src/host"
import { LaterDatabase } from "../src/sqlite"

const cleanup: Array<() => void> = []
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop() })

function harness(initial: Route = { type: "home" }, sharedPath?: string) {
  const directory = tempDir("opcode-later-host-")
  cleanup.push(directory.remove)
  const path = sharedPath ?? join(directory.path, "later.sqlite")
  const database = new LaterDatabase(path)
  const external = new LaterDatabase(path)
  cleanup.push(() => database.close(), () => external.close())
  let route = initial
  let prompt = async (): Promise<string | undefined> => undefined
  let confirm = async (): Promise<boolean | undefined> => true
  let nextFrame = Promise.resolve()
  let pasteHook = () => {}
  let ready = true
  let updates = 0
  const pastes: string[] = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const renderer = Object.assign(new EventEmitter(), {
    isDestroyed: false,
    requestRender: () => { void nextFrame.then(() => renderer.emit(CliRenderEvents.FRAME)) },
    keyInput: { processPaste: (bytes: Uint8Array) => { pasteHook(); pastes.push(new TextDecoder().decode(bytes)) } },
  })
  const api = {
    renderer,
    keymap: { commands: () => ready ? [{ id: "prompt.paste" }] : [] },
    ui: {
      router: {
        current: () => route,
        navigate: (destination: Destination) => {
          route = destination.type === "plugin" ? { id: "opcode-later", ...destination } : destination
        },
      },
      toast: { show: (toast: { message: string; variant?: string }) => toasts.push(toast) },
      dialog: { prompt: () => prompt(), confirm: () => confirm() },
    },
  }
  const host = new LaterController(api as unknown as Context, database, () => { updates++ })
  cleanup.push(() => host.dispose())
  return {
    host, database, external, pastes, toasts, api, path,
    route: () => route,
    navigate: (next: Route) => { route = next },
    prompt: (value: string | undefined) => { prompt = async () => value },
    promptPending: (promise: Promise<string | undefined>) => { prompt = () => promise },
    confirm: (value: boolean) => { confirm = async () => value },
    confirmPending: (promise: Promise<boolean | undefined>) => { confirm = () => promise },
    frame: (promise: Promise<void>) => { nextFrame = promise },
    ready: (value: boolean) => { ready = value },
    pasteHook: (callback: () => void) => { pasteHook = callback },
    updates: () => updates,
  }
}

test("keyboard actions cover adding, editing, reordering, history, restoring, and confirmed deletion", async () => {
  const h = harness()
  await h.host.run("open")
  h.prompt("one")
  await h.host.run("add")
  h.prompt("two")
  await h.host.run("add")
  h.prompt("edited")
  await h.host.run("edit")
  await h.host.run("moveDown")
  expect(h.database.snapshot().active.map((item) => item.message)).toEqual(["two", "edited"])
  await h.host.run("complete")
  expect(h.database.snapshot().completed.map((item) => item.message)).toEqual(["edited"])
  await h.host.run("history")
  await h.host.run("down")
  await h.host.run("complete")
  expect(h.database.snapshot().active.map((item) => item.message)).toEqual(["two", "edited"])
  h.confirm(false)
  await h.host.run("delete")
  expect(h.database.snapshot().active).toHaveLength(2)
  h.confirm(true)
  await h.host.run("delete")
  expect(h.database.snapshot().active.map((item) => item.message)).toEqual(["edited"])
})

test("cancelled and invalid additions do not mutate", async () => {
  const h = harness()
  await h.host.run("open")
  await h.host.run("add")
  h.prompt(" \n ")
  await h.host.run("add")
  expect(h.database.revision()).toBe(0)
  expect(h.toasts.at(-1)).toMatchObject({ variant: "error", message: "Message cannot be empty" })
})

test("external deletion cannot make an unrefreshed action complete the first remaining item", async () => {
  const h = harness()
  const first = h.external.add("first")
  const second = h.external.add("second")
  await h.host.run("open")
  h.external.delete(h.external.get(first)!)
  await h.host.run("complete")
  expect(h.database.get(second)?.completedAt).toBeUndefined()
  expect(h.host.model.view().selectedID).toBe(second)
  expect(h.toasts.at(-1)?.variant).toBe("warning")
})

test("polling repairs the rendered selection after an external deletion", async () => {
  const h = harness()
  const first = h.external.add("first")
  const second = h.external.add("second")
  await h.host.run("open")
  const updates = h.updates()
  h.external.delete(h.external.get(first)!)
  h.host.poll()
  expect(h.host.model.view().selectedID).toBe(second)
  expect(h.updates()).toBe(updates + 1)
})

test.each([{ type: "home" }, { type: "session", sessionID: "session-1" }] as const)("paste and complete returns to %j without submitting", async (origin) => {
  const h = harness(origin)
  h.database.add("café ☕\nadd tests")
  await h.host.run("open")
  await h.host.run("open")
  await h.host.run("paste")
  expect(h.route()).toEqual(origin)
  expect(h.pastes).toEqual(["café ☕\nadd tests"])
  expect(h.database.snapshot().active).toEqual([])
  expect(h.database.snapshot().completed).toHaveLength(1)
  expect(h.toasts.at(-1)?.message).toContain("Nothing was submitted")
})

test("readiness timeout preserves the item and releases the command's busy state", async () => {
  const h = harness()
  h.database.add("keep me")
  await h.host.run("open")
  h.ready(false)
  await h.host.run("paste")
  expect(h.pastes).toEqual([])
  expect(h.database.snapshot().active).toHaveLength(1)
  expect(h.toasts.at(-1)?.variant).toBe("error")
  const enabled = h.host.command("open", "Later").enabled as () => boolean
  expect(enabled()).toBe(true)
  await h.host.run("open")
  expect(h.route()).toMatchObject({ type: "plugin", id: "opcode-later", name: MANAGER_ROUTE })
})

test("a destination change during mounting cancels paste", async () => {
  const h = harness({ type: "session", sessionID: "one" })
  h.database.add("keep me")
  await h.host.run("open")
  const frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  const pending = h.host.run("paste")
  h.navigate({ type: "session", sessionID: "two" })
  frame.resolve()
  await pending
  expect(h.pastes).toEqual([])
  expect(h.database.snapshot().active).toHaveLength(1)
})

test.each(["edit", "delete", "complete"])("an external %s during mounting cancels stale paste", async (action) => {
  const h = harness()
  const id = h.database.add("old text", 1)
  await h.host.run("open")
  const frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  const pending = h.host.run("paste")
  const item = h.external.get(id)!
  if (action === "edit") h.external.edit(item, "new text", 2)
  if (action === "delete") h.external.delete(item)
  if (action === "complete") h.external.complete(item, 2)
  frame.resolve()
  await pending
  expect(h.pastes).toEqual([])
  if (action === "edit") expect(h.database.get(id)).toMatchObject({ message: "new text", completedAt: undefined })
})

test("another client completing an unrelated item does not make the selected item stale", async () => {
  const h = harness()
  const above = h.database.add("above", 1)
  const target = h.database.add("complete me", 2)
  await h.host.run("open")
  await h.host.run("down")
  h.external.complete(h.external.get(above)!, 3)
  await h.host.run("complete")
  expect(h.database.get(target)?.completedAt).toBeDefined()
  expect(h.toasts.at(-1)?.variant).toBe("success")
})

test("another client completing an unrelated item does not cancel a pending paste", async () => {
  const h = harness()
  const above = h.database.add("above", 1)
  const target = h.database.add("paste me", 2)
  await h.host.run("open")
  await h.host.run("down")
  const frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  const pending = h.host.run("paste")
  h.external.complete(h.external.get(above)!, 3)
  frame.resolve()
  await pending
  expect(h.pastes).toEqual(["paste me"])
  expect(h.database.get(target)?.completedAt).toBeDefined()
  expect(h.toasts.at(-1)?.variant).toBe("success")
})

test("repeated paste while mounting delivers once", async () => {
  const h = harness()
  h.database.add("once")
  await h.host.run("open")
  const frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  const pending = h.host.run("paste")
  await h.host.run("paste")
  frame.resolve()
  await pending
  expect(h.pastes).toEqual(["once"])
})

test("unloading a pending paste never accesses the closed database", async () => {
  const h = harness()
  h.database.add("keep me")
  await h.host.run("open")
  const frame = Promise.withResolvers<void>()
  h.frame(frame.promise)
  const pending = h.host.run("paste")
  h.host.dispose()
  h.database.close()
  expect(h.api.renderer.listenerCount(CliRenderEvents.FRAME)).toBe(0)
  expect(h.api.renderer.listenerCount(CliRenderEvents.DESTROY)).toBe(0)
  await pending
  frame.resolve()
  expect(h.pastes).toEqual([])
  expect(h.external.snapshot().active).toHaveLength(1)
  expect(h.toasts).toEqual([])
})

test("paste failure does not complete the item", async () => {
  const h = harness()
  h.database.add("keep me")
  await h.host.run("open")
  h.pasteHook(() => { throw new Error("paste failed") })
  await h.host.run("paste")
  expect(h.database.snapshot().active).toHaveLength(1)
  expect(h.toasts.at(-1)?.message).toBe("paste failed")
})

test("a change during delivery is not silently marked complete", async () => {
  const h = harness()
  const id = h.database.add("original", 1)
  await h.host.run("open")
  h.pasteHook(() => { h.external.edit(h.external.get(id)!, "newer", 2) })
  await h.host.run("paste")
  expect(h.pastes).toEqual(["original"])
  expect(h.database.get(id)).toMatchObject({ message: "newer", completedAt: undefined })
  expect(h.toasts.at(-1)?.message).toContain("not marked complete")
})

test("a database failure after paste explicitly warns that text was already delivered", async () => {
  const h = harness()
  h.database.add("already pasted")
  await h.host.run("open")
  const raw = new Database(h.path)
  try {
    raw.exec("CREATE TRIGGER reject_completion BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT, 'completion failed'); END")
    await h.host.run("paste")
    expect(h.pastes).toEqual(["already pasted"])
    expect(h.external.snapshot().active).toHaveLength(1)
    expect(h.toasts.at(-1)).toMatchObject({ variant: "error" })
    expect(h.toasts.at(-1)?.message).toContain("Text was pasted")
    expect(h.toasts.at(-1)?.message).toContain("Check /later before trying again")
  } finally { raw.close() }
})

test("pending edit is cancelled on unload, even if the database is closed", async () => {
  const h = harness()
  h.database.add("original")
  await h.host.run("open")
  const prompt = Promise.withResolvers<string | undefined>()
  h.promptPending(prompt.promise)
  const pending = h.host.run("edit")
  h.host.dispose()
  h.database.close()
  prompt.resolve("must not save")
  await pending
  expect(h.external.snapshot().active[0]?.message).toBe("original")
})

test("leaving the manager while adding cancels admission", async () => {
  const h = harness()
  await h.host.run("open")
  const prompt = Promise.withResolvers<string | undefined>()
  h.promptPending(prompt.promise)
  const pending = h.host.run("add")
  h.navigate({ type: "home" })
  prompt.resolve("must not save")
  await pending
  expect(h.database.revision()).toBe(0)
})

test("a dialog the host never settles does not disable /later or later actions", async () => {
  const h = harness()
  const id = h.database.add("original", 1)
  await h.host.run("open")
  h.promptPending(new Promise(() => {}))
  void h.host.run("edit")
  h.confirmPending(new Promise(() => {}))
  void h.host.run("delete")
  h.navigate({ type: "home" })
  const open = h.host.command("open", "Later")
  expect((open.enabled as () => boolean)()).toBe(true)
  await h.host.run("open")
  expect(h.route()).toMatchObject({ type: "plugin", id: "opcode-later", name: MANAGER_ROUTE })
  h.prompt("added")
  await h.host.run("add")
  h.prompt("edited")
  await h.host.run("edit")
  expect(h.database.snapshot().active.map((item) => item.message)).toEqual(["edited", "added"])
  await h.host.run("complete")
  expect(h.database.get(id)?.completedAt).toBeDefined()
})

test("stale edit and delete dialogs do not overwrite newer content", async () => {
  const h = harness()
  const id = h.database.add("original", 1)
  await h.host.run("open")
  const prompt = Promise.withResolvers<string | undefined>()
  h.promptPending(prompt.promise)
  const editing = h.host.run("edit")
  h.external.edit(h.external.get(id)!, "newer", 2)
  prompt.resolve("stale edit")
  await editing
  expect(h.database.get(id)?.message).toBe("newer")
  const confirm = Promise.withResolvers<boolean | undefined>()
  h.confirmPending(confirm.promise)
  const deleting = h.host.run("delete")
  h.external.edit(h.external.get(id)!, "newest", 3)
  confirm.resolve(true)
  await deleting
  expect(h.database.get(id)?.message).toBe("newest")
})

test("completed timestamp zero cannot be pasted/reordered and is restored rather than completed again", async () => {
  const h = harness()
  const id = h.database.add("done", 1)
  h.database.complete(h.database.get(id)!, 0)
  await h.host.run("open")
  await h.host.run("history")
  const revision = h.database.revision()
  await h.host.run("paste")
  await h.host.run("moveUp")
  expect(h.pastes).toEqual([])
  expect(h.route()).toMatchObject({ type: "plugin", id: "opcode-later", name: MANAGER_ROUTE })
  expect(h.database.revision()).toBe(revision)
  await h.host.run("complete")
  expect(h.database.snapshot().active.map((item) => item.id)).toEqual([id])
})

test("back and idempotent disposal restore the originating route", async () => {
  const origin: Route = { type: "session", sessionID: "origin" }
  const h = harness(origin)
  await h.host.run("open")
  expect(h.route()).toMatchObject({ type: "plugin", name: MANAGER_ROUTE })
  await h.host.run("close")
  expect(h.route()).toEqual(origin)
  await h.host.run("open")
  h.host.dispose()
  h.host.dispose()
  expect(h.route()).toEqual(origin)
})

test("starting from another plugin route does not pretend a prompt exists", async () => {
  const h = harness({ type: "plugin", id: "other", name: "other.page" })
  h.database.add("keep me")
  await h.host.run("open")
  await h.host.run("paste")
  expect(h.route()).toMatchObject({ type: "plugin", name: MANAGER_ROUTE })
  expect(h.pastes).toEqual([])
  expect(h.database.snapshot().active).toHaveLength(1)
})

test("another plugin's same-name route is never treated as Later's manager", async () => {
  const other: Route = { type: "plugin", id: "other-plugin", name: MANAGER_ROUTE }
  const h = harness(other)
  h.database.add("untouched")
  await h.host.run("complete")
  await h.host.run("close")
  expect(h.route()).toEqual(other)
  expect(h.database.snapshot().active).toHaveLength(1)
  await h.host.run("open")
  expect(h.route()).toEqual({ type: "plugin", id: "opcode-later", name: MANAGER_ROUTE })
  await h.host.run("close")
  expect(h.route()).toEqual(other)
  await h.host.run("open")
  const prompt = Promise.withResolvers<string | undefined>()
  h.promptPending(prompt.promise)
  const editing = h.host.run("edit")
  h.navigate(other)
  prompt.resolve("must not save")
  await editing
  h.host.dispose()
  expect(h.route()).toEqual(other)
  expect(h.database.snapshot().active[0]?.message).toBe("untouched")
})

test("independent controllers share contents but preserve their own selections", async () => {
  const first = harness()
  const one = first.database.add("one", 1)
  const two = first.database.add("two", 2)
  const three = first.database.add("three", 3)
  const second = harness({ type: "session", sessionID: "different-client" }, first.path)
  await first.host.run("open")
  await second.host.run("open")
  await second.host.run("down")
  await second.host.run("down")
  expect(first.host.model.view().selectedID).toBe(one)
  expect(second.host.model.view().selectedID).toBe(three)
  await first.host.run("complete")
  second.host.poll()
  expect(first.host.model.view().selectedID).toBe(two)
  expect(second.host.model.view().selectedID).toBe(three)
  expect(first.host.model.view().active).toEqual(second.host.model.view().active)
  expect(second.host.model.view().completed.map((item) => item.id)).toEqual([one])
})
