import { expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { refreshesSnapshot } from "../src/refresh"

test("only completed changes in the open session trigger refreshes", () => {
  const event = (type: string, sessionID = "s") => ({ type, data: { sessionID } }) as unknown as OpenCodeEvent
  for (const type of ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta", "session.step.streamed", "session.status"]) {
    expect(refreshesSnapshot(event(type), "s")).toBe(false)
  }
  for (const type of ["session.step.ended", "session.tool.success", "session.usage.updated", "session.compaction.ended", "session.idle"]) {
    expect(refreshesSnapshot(event(type), "s")).toBe(true)
  }
  expect(refreshesSnapshot(event("session.step.ended", "other"), "s")).toBe(false)
  expect(refreshesSnapshot(event("session.step.ended"), undefined)).toBe(false)
})
