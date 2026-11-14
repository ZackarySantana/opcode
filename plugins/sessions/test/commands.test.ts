import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { availableSlashNames } from "../src/tui"

test("slash commands retain original names only when unoccupied", () => {
  const api = {
    location: { directory: "/work/alpha" },
    data: { location: { command: { list: () => [{ name: "all-sessions" }] } } },
    keymap: { commands: () => [{ slash: { name: "sessions", aliases: ["browse"] }, run() {} }] },
  } as unknown as Context
  expect(availableSlashNames(api, ["sessions", "sessions-all", "all-sessions", "browse"])).toEqual(["sessions-all"])
})
