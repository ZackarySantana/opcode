import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { answerOf, askMetadata, mergeRead, streamText, type Ask } from "../src/ask"

const ask: Ask = { id: "msg_q1", anchor: { file: "a.ts", side: "new", start: 1, end: 1, quote: ["+x"] }, question: "Why?" }
const user = (id: string) => ({ id, type: "user", text: "...", metadata: askMetadata(id), time: { created: 1 } })
const assistant = (content: unknown[], extra = {}) => ({ id: `msg_a${content.length}`, type: "assistant", agent: "build", model: { id: "m", providerID: "p" }, time: { created: 2 }, content, ...extra })
const idle = (outcome = "succeeded", extra = {}) => ({ id: "msg_idle", type: "idle", outcome, time: { created: 3 }, ...extra })
const of = (...messages: unknown[]) => messages as SessionMessageInfo[]

test("an answer is what the model wrote after its last look around, done once the session goes idle or moves on", () => {
  const read = { type: "tool", name: "read" }
  const thinking = { type: "text", text: "Let me check the caller." }
  expect(answerOf([], ask).state).toBe("waiting")
  expect(answerOf(of(user("msg_q1")), ask)).toMatchObject({ state: "thinking", text: "" })
  expect(answerOf(of(user("msg_q1"), assistant([thinking, read])), ask)).toEqual({ state: "thinking", text: "", looked: ["read"] })
  const writing = of(user("msg_q1"), assistant([thinking, read, { type: "text", text: "Because" }]))
  expect(answerOf(writing, ask)).toEqual({ state: "answering", text: "Because", looked: ["read"] })
  expect(answerOf([...writing, ...of(idle())], ask)).toEqual({ state: "done", text: "Because", looked: ["read"] })
  // The next question starting means this one is done.
  expect(answerOf([...writing, ...of(user("msg_q2"))], ask).state).toBe("done")
})

test("a question that never arrived, a failed model, or a stopped answer shows why", () => {
  expect(answerOf([], { ...ask, error: "Session not found" })).toMatchObject({ state: "failed", error: "Session not found" })
  expect(answerOf(of(user("msg_q1"), assistant([], { error: { type: "provider", message: "Rate limited" } }), idle("failed")), ask)).toMatchObject({ state: "failed", error: "Rate limited" })
  expect(answerOf(of(user("msg_q1"), idle("interrupted")), ask)).toMatchObject({ state: "failed", error: "Stopped" })
})

test("streamed text builds the answer before it's stored, and a read behind the stream doesn't lose it", () => {
  let messages = of(user("msg_q1"))
  messages = streamText(messages, { type: "started", messageID: "msg_live", at: 2 })
  messages = streamText(messages, { type: "delta", messageID: "msg_live", delta: "Ye" })
  messages = streamText(messages, { type: "delta", messageID: "msg_live", delta: "s." })
  expect(answerOf(messages, ask)).toMatchObject({ state: "answering", text: "Yes." })

  // The server has stored less of it so far: the streamed text stays until the stored message is complete.
  const behind = of(user("msg_q1"), { ...assistant([{ type: "text", text: "Ye" }]), id: "msg_live", time: { created: 2 } })
  expect(answerOf(mergeRead(messages, behind), ask).text).toBe("Yes.")
  const stored = of(user("msg_q1"), { ...assistant([{ type: "text", text: "Yes, it is." }]), id: "msg_live", time: { created: 2, completed: 3 } }, idle())
  expect(answerOf(mergeRead(messages, stored), ask)).toMatchObject({ state: "done", text: "Yes, it is." })
})
