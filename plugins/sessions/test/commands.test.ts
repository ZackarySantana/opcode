import { expect, test } from "bun:test"
import type { Context, KeymapCommand, KeymapLayer } from "@opencode/plugin/tui/context"
import { availableSlashNames, registerInboxCommands } from "../src/tui"
import type { Inbox } from "../src/inbox-host"

test("slash commands retain original names only when unoccupied", () => {
  const api = {
    location: { directory: "/work/alpha" },
    data: { location: { command: { list: () => [{ name: "all-sessions" }] } } },
    keymap: { commands: () => [{ slash: { name: "sessions", aliases: ["go"] }, run() {} }] },
  } as unknown as Context
  expect(availableSlashNames(api, ["sessions", "sessions-all", "all-sessions", "go"])).toEqual(["sessions-all"])
})

test("/go opens the sidebar's numbered row, goes back, lists without a number, and rejects other input; /back goes back too", async () => {
  const opened: string[] = []
  const toasts: string[] = []
  const layers: KeymapLayer[] = []
  let wentBack = 0
  let listed = 0
  const inbox = {
    rows: () => [{ id: "first", state: "working", agents: 0, since: 0, title: "First", directory: "/a" }, { id: "second", state: "finished", agents: 0, since: 0, title: "Second", directory: "/b" }],
    currentRoot: () => undefined, open: (id: string) => opened.push(id),
    // Only the first back succeeds.
    goBack: () => ++wentBack === 1,
  } as unknown as Inbox
  const api = {
    keymap: { layer: (factory: () => KeymapLayer) => layers.push(factory()) },
    ui: { toast: { show: (toast: { message: string }) => toasts.push(toast.message) }, dialog: { select: async () => { listed++; return "first" } } },
  } as unknown as Context
  registerInboxCommands(api, inbox, { go: ["go"], back: ["back", "previous"] })
  const [go, back] = layers[0]!.commands! as [KeymapCommand, KeymapCommand]
  expect(go.slash).toEqual({ name: "go", aliases: [], arguments: true })
  await go.run("2")
  await go.run(" Back ")
  await go.run("")
  await go.run("3")
  expect(opened).toEqual(["second", "first"])
  expect(wentBack).toBe(1)
  expect(listed).toBe(1)
  expect(toasts).toEqual(["No active session 3. Use /go to list them."])
  await back.run()
  expect(wentBack).toBe(2)
  expect(toasts.at(-1)).toBe("Nothing to go back to.")
  registerInboxCommands(api, inbox, { go: [], back: [] })
  const unnamed = layers[1]!.commands![0]!
  expect(unnamed.slash).toBeUndefined()
  await unnamed.run("3")
  expect(toasts.at(-1)).toBe("No active session 3. Use Go to active session to list them.")
})
