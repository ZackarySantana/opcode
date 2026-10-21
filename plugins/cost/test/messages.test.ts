import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { parseImportBatch } from "../src/domain.js"
import { isUsageMessage, usageFromMessage } from "../src/messages.js"
import { message, tokens } from "./fixtures.js"

test("maps provider-reported usage and normalizes missing/non-finite/negative numbers", () => {
  expect(usageFromMessage(message)).toEqual({
    messageID: message.id, providerID: message.model.providerID, modelID: message.model.id,
    createdAt: message.time.created, completedAt: message.time.completed,
    cost: 0.5, input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5,
  })
  expect(usageFromMessage({ ...message, cost: NaN, tokens: undefined })).toMatchObject({ cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  expect(usageFromMessage({ ...message, tokens: { ...tokens, input: -1, output: Infinity } })).toMatchObject({ input: 0, output: 0 })
})

test("only assistants and completed modeled compactions qualify", () => {
  expect(isUsageMessage(message)).toBe(true)
  for (const value of [
    { type: "user" }, { type: "compaction", status: "running" }, { type: "compaction", status: "failed" },
    { type: "compaction", status: "completed" },
  ]) expect(isUsageMessage(value as SessionMessageInfo)).toBe(false)
  expect(isUsageMessage({ type: "compaction", status: "completed", model: message.model } as SessionMessageInfo)).toBe(true)
})

test("RPC batch validation bounds payloads and reconstructs metadata only", () => {
  const usage = usageFromMessage(message)
  expect(parseImportBatch({ sessionID: "session", records: [{ ...usage, content: "must not persist", projectID: "spoofed" }] }).records[0]).toEqual(usage)
  for (const input of [
    { sessionID: "", records: [usage] }, { sessionID: "session", records: [] },
    { sessionID: "session", records: Array(101).fill(usage) },
    { sessionID: "session", records: [{ ...usage, modelID: "x".repeat(513) }] },
    { sessionID: "session", records: [{ ...usage, cost: Infinity }] },
    { sessionID: "session", records: [{ ...usage, input: -1 }] },
    { sessionID: "session", records: [{ ...usage, cost: 1e13 }] },
    { sessionID: "session", records: [{ ...usage, completedAt: usage.createdAt - 1 }] },
  ]) expect(() => parseImportBatch(input)).toThrow()
})
