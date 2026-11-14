import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { answerOf, askMetadata, type Ask } from "../src/ask"

const ask: Ask = { id: "msg_q1", anchor: { file: "a.ts", side: "new", start: 1, end: 1, quote: ["+x"] }, question: "Why?" }
const user = (id: string) => ({ id, type: "user", text: "...", metadata: askMetadata(id), time: { created: 1 } })
const assistant = (content: unknown[], extra = {}) => ({ id: `msg_a${content.length}`, type: "assistant", agent: "build", model: { id: "m", providerID: "p" }, time: { created: 2 }, content, ...extra })

test("an answer is what the model wrote after its last look around, and settles when the session stops or moves on", () => {
  const read = { type: "tool", name: "read" }
  const thinking = { type: "text", text: "Let me check the caller." }
  expect(answerOf([], ask, true).state).toBe("waiting")
  expect(answerOf([user("msg_q1")] as SessionMessageInfo[], ask, true)).toMatchObject({ state: "thinking", text: "" })

  const looking = [user("msg_q1"), assistant([thinking, read])] as SessionMessageInfo[]
  expect(answerOf(looking, ask, true)).toEqual({ state: "thinking", text: "", looked: ["read"] })
  const writing = [user("msg_q1"), assistant([thinking, read, { type: "text", text: "Because" }])] as SessionMessageInfo[]
  expect(answerOf(writing, ask, true)).toEqual({ state: "answering", text: "Because", looked: ["read"] })
  expect(answerOf(writing, ask, false).state).toBe("done")
  // The next question starting means this one is done, though the session still works.
  expect(answerOf([...writing, user("msg_q2")] as SessionMessageInfo[], ask, true).state).toBe("done")
})

test("a question that never arrived, or a model that failed without answering, shows why", () => {
  expect(answerOf([], { ...ask, error: "Session not found" }, false)).toMatchObject({ state: "failed", error: "Session not found" })
  const failed = [user("msg_q1"), assistant([], { error: { type: "provider", message: "Rate limited" } })] as SessionMessageInfo[]
  expect(answerOf(failed, ask, false)).toMatchObject({ state: "failed", error: "Rate limited" })
})
