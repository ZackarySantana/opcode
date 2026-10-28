import { afterEach, expect, test } from "bun:test"
import { closeServers, eventually, manualTimers, stopped } from "@opcode/core/test-support/server"
import type { LaterList, LaterState } from "../src/domain"
import { joinService, joinWrites, LaterService, type Ports } from "../src/service"
import { find, laterServer, messages, remote } from "./fixture"

afterEach(closeServers)

const announced = (f: ReturnType<typeof laterServer>) => f.server.events.map((event) => ({ directory: event.directory, state: event.data as LaterState }))

test("every location changes one list, and changes made together are announced once, with all of them", async () => {
  const timers = manualTimers()
  const f = laterServer({ timer: timers.timer })
  const home = remote(f.server, "/home/me"), web = remote(f.server, "/work/web")
  const first = await home.add("first")
  await web.add("second")
  await f.tool("later_add", { message: "third" }, "/work/web")
  expect(messages(await home.state())).toEqual(["first", "second", "third"])
  expect(f.server.stored.get("list")).toMatchObject({ revision: 3 })
  expect(announced(f)).toEqual([])
  timers.fire(100)
  await eventually(() => expect(announced(f)).toHaveLength(1))
  expect(messages(announced(f)[0]!.state)).toEqual(["first", "second", "third"])
  expect(announced(f)[0]!.state.revision).toBe(3)

  // The location that announced unloads; another announces from then on.
  const announcer = announced(f)[0]!.directory
  await f.server.unload(announcer)
  const other = announcer === "/home/me" ? web : home
  await other.move(first.id, 1)
  timers.fire(100)
  await eventually(() => expect(announced(f)).toHaveLength(2))
  expect(announced(f)[1]).toMatchObject({ directory: announcer === "/home/me" ? "/work/web" : "/home/me", state: { revision: 4 } })

  // A new service, once every location unloaded, continues from the stored list and its revision.
  await f.server.close()
  const after = await home.state()
  expect(messages(after)).toEqual(["second", "first", "third"])
  expect(after.revision).toBe(4)
})

test("a stored list that can't be read fails reads and changes, is never replaced, and is read again on the next call", async () => {
  const f = laterServer({ timer: stopped })
  const home = remote(f.server)
  const id = (await home.add("irreplaceable")).id
  const stored = f.server.stored.get("list")
  f.server.faults.get = true
  await expect(home.state()).rejects.toThrow("can't be read right now")
  await expect(home.add("new")).rejects.toThrow("can't be read right now")
  await expect(home.settings({ sidebarItems: 3 })).rejects.toThrow("can't be read right now")
  await expect(f.tool("later_add", { message: "new" })).rejects.toThrow("can't be read right now")
  expect(f.server.stored.get("list")).toEqual(stored)

  f.server.faults.get = false
  expect(messages(await home.add("new").then(() => home.state()))).toEqual(["irreplaceable", "new"])

  // A change that can't be saved fails with the reason and changes nothing.
  f.server.faults.set = true
  await expect(home.edit(find(await home.state(), id), "lost")).rejects.toThrow("disk full")
  expect(find(await home.state(), id).message).toBe("irreplaceable")
})

test("a stored list in a form this version doesn't read is never overwritten", async () => {
  const garbled = { revision: 2, active: [{ id: "a", message: 7 }], completed: [] }
  const f = laterServer({ timer: stopped, stored: new Map([["list", garbled]]) })
  const home = remote(f.server)
  await expect(home.state()).rejects.toThrow("not in a form")
  await expect(home.add("new")).rejects.toThrow("not in a form")
  await expect(home.settings({ agentTools: false })).rejects.toThrow("not in a form")
  expect(f.server.stored.get("list")).toEqual(garbled)
})

test("a change keeps what a newer version stored beside the list and its items", async () => {
  const stored = { revision: 1, active: [{ id: "a", message: "kept", createdAt: 1, updatedAt: 1, color: "red" }], completed: [], sidebarItems: 5, theirs: true }
  const f = laterServer({ timer: stopped, stored: new Map<string, unknown>([["list", stored]]) })
  const home = remote(f.server)
  const state = await home.state()
  expect(state.active).toEqual([{ id: "a", message: "kept", createdAt: 1, updatedAt: 1 }])
  await home.add("new")
  expect(f.server.stored.get("list")).toMatchObject({ revision: 2, theirs: true, active: [{ id: "a", color: "red" }, { message: "new" }] })
})

/** Plugin storage whose reads and writes take turns with other work, as the host's do. */
function slowStorage() {
  let stored: unknown
  const ports: Ports = {
    load: async () => { await Bun.sleep(1); return stored },
    save: async (list: LaterList) => { await Bun.sleep(1); stored = JSON.parse(JSON.stringify(list)) },
    publish: async () => {},
  }
  return { ports, stored: () => stored as LaterList }
}

test("two services in one process, as while an upgrade runs two versions, never lose each other's changes", async () => {
  const storage = slowStorage()
  const writes = [joinWrites(), joinWrites()]
  try {
    const older = new LaterService(storage.ports, writes[0]!.value, stopped)
    const newer = new LaterService(storage.ports, writes[1]!.value, stopped)
    const added = await Promise.all(["one", "two", "three", "four"].map((text, index) => (index % 2 ? older : newer).add(text)))
    expect(storage.stored().active.map((item) => item.message).sort()).toEqual(["four", "one", "three", "two"])
    expect(storage.stored().revision).toBe(4)

    // Each edits the item as it saw it: the second is refused rather than overwriting the first.
    const item = find(added[3]!.state, added[0]!.id)
    const [first, second] = await Promise.all([older.edit(item, "older's"), newer.edit(item, "newer's")])
    expect([first.changed, second.changed]).toEqual([true, false])
    expect(second.state.active.find((entry) => entry.id === item.id)?.message).toBe("older's")
  } finally { for (const joined of writes) joined.leave() }
})

test("a stopped service refuses changes and drops its pending announcement", async () => {
  const timers = manualTimers()
  const published: LaterState[] = []
  const ports: Ports = { load: async () => undefined, save: async () => {}, publish: async (state) => { published.push(state) } }
  const writes = joinWrites()
  try {
    const service = new LaterService(ports, writes.value, timers.timer)
    await service.add("one")
    service.dispose()
    timers.fire(100)
    expect(published).toEqual([])
    await expect(service.add("two")).rejects.toThrow("stopped")
  } finally { writes.leave() }
})

test("a service starting while a stopped one still saves a change waits for it, so neither change is lost", async () => {
  let stored: unknown
  const saving = Promise.withResolvers<void>()
  const ports = (gate?: Promise<void>): Ports => ({
    load: async () => stored,
    save: async (list) => { await gate; stored = JSON.parse(JSON.stringify(list)) },
    publish: async () => {},
  })
  const first = joinService(ports(saving.promise), stopped)
  const adding = first.service.add("first")
  await Bun.sleep(1)
  // Every location unloads while the save is in flight, and one loads again at once.
  first.leave()
  const second = joinService(ports(), stopped)
  try {
    const next = second.service.add("second")
    await Bun.sleep(1)
    saving.resolve()
    await Promise.all([adding, next])
    expect((stored as LaterList).active.map((item) => item.message)).toEqual(["first", "second"])
  } finally { second.leave() }
})
