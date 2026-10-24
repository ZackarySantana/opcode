import { expect, test } from "bun:test"
import { messageRecord, sessionRecord } from "../src/domain"
import { validateBatch } from "../src/rpc"
import { assistant, message, session, user } from "./fixtures"

test("projects only user/assistant text and truthful recorded metrics", () => {
  const row = assistant()
  row.content.push({ type: "reasoning", text: "not searchable" }, { type: "tool", id: "call", name: "read", time: { created: 3 }, state: { status: "completed", input: { path: ".env" }, content: [{ type: "text", text: "TOOL_SECRET" }] } })
  expect(messageRecord(row)).toMatchObject({ text: "JWT rotation completed", cost: 0.25, input: 100, output: 20, reasoning: 5, cacheRead: 10, cacheWrite: 2 })
  expect(messageRecord(user())).toMatchObject({ role: "user", cost: 0 })
  expect(messageRecord({ id: "synthetic", type: "synthetic", text: "skip", time: { created: 1 } })).toBeUndefined()
  expect(messageRecord({ ...row, tokens: undefined, cost: undefined })).toMatchObject({ cost: 0, input: 0 })
  expect(sessionRecord({ ...session(), title: undefined, parentID: "root" })).toMatchObject({ title: "Untitled session", directory: "/work/alpha", parentID: "root" })
})

test("history batches reject excessive sizes and invalid metrics rather than truncating", () => {
  expect(() => validateBatch([message()])).not.toThrow()
  expect(() => validateBatch(Array.from({ length: 33 }, (_, n) => message(`m${n}`)))).toThrow("batch size")
  expect(() => validateBatch([message("long", "x".repeat(1_048_577))])).toThrow("1 MiB")
  expect(() => validateBatch([{ ...message(), cost: NaN }])).toThrow("cost")
  expect(() => validateBatch([{ ...message(), output: -1 }])).toThrow("output")
  expect(() => validateBatch([{ ...message(), cost: 1 }])).toThrow("User messages")
})
