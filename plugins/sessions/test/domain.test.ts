import { expect, test } from "bun:test"
import { messageRecord, sessionRecord, viewport } from "../src/domain"
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

test("viewport follows keyboard selection, resize, and shrinking results", () => {
  expect(viewport(25, 100, 10)).toEqual({ selected: 25, start: 16, size: 10 })
  expect(viewport(5, 100, 10, 16)).toEqual({ selected: 5, start: 5, size: 10 })
  expect(viewport(25, 100, 5, 16)).toEqual({ selected: 25, start: 21, size: 5 })
  expect(viewport(25, 3, 10, 16)).toEqual({ selected: 2, start: 0, size: 10 })
  expect(viewport(0, 0, 0)).toEqual({ selected: 0, start: 0, size: 1 })
})

test("history batches reject excessive sizes and invalid metrics rather than truncating", () => {
  expect(() => validateBatch([message()])).not.toThrow()
  expect(() => validateBatch(Array.from({ length: 33 }, (_, n) => message(`m${n}`)))).toThrow("batch size")
  expect(() => validateBatch([message("long", "x".repeat(1_048_577))])).toThrow("1 MiB")
  expect(() => validateBatch([{ ...message(), cost: NaN }])).toThrow("cost")
  expect(() => validateBatch([{ ...message(), output: -1 }])).toThrow("output")
  expect(() => validateBatch([{ ...message(), cost: 1 }])).toThrow("User messages")
})
