import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ReviewController } from "../src/host"
import { parsePatch } from "../src/patch"
import { anchorOf, drafts, type Reply } from "../src/review"
import { patch } from "./fixtures"
import { fakeHost, fastTimer, SESSION, settle } from "./host"

const rows = parsePatch(patch)

function setup(replies: (sessionID: string) => Promise<Record<string, Reply>> = async () => ({})) {
  const host = fakeHost()
  return createRoot((dispose) => {
    const review = new ReviewController(host.api, { replies: (sessionID) => replies(sessionID), timer: fastTimer })
    const comment = (text: string, row = 3) => review.addComment(SESSION, anchorOf("src/auth.ts", rows, row, row), text)
    const states = () => [...review.deliveries(SESSION).values()]
    return { ...host, review, comment, states, dispose: () => { review.dispose(); dispose() } }
  })
}

test("S sends every draft as one steering message, and pressing it again while that's in flight joins it", async () => {
  const { review, comment, states, prompts, respond, toasts, dispose } = setup()
  await comment("Use config")
  await comment("Why here??", 5)
  let admit!: () => void
  respond(() => new Promise((resolve) => { admit = () => resolve({}) }))

  // Pressed twice before the first request even starts.
  const first = review.send(SESSION, "This turn")
  const second = review.send(SESSION, "This turn")
  await settle()
  expect(prompts).toHaveLength(1)
  expect(states()).toEqual(["sending", "sending"])

  admit()
  await Promise.all([first, second])
  expect(prompts).toHaveLength(1)
  const [sent] = prompts
  expect(sent).toMatchObject({ sessionID: SESSION, delivery: "steer" })
  // A host message ID, so the host can tell a retry from a new message.
  expect(sent!.id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  expect(sent!.text).toContain("[r1] src/auth.ts:2")
  expect(sent!.text).toContain("[r2] src/auth.ts:4 [question]")
  expect(states()).toEqual(["sent", "sent"])
  expect(toasts.at(-1)).toMatchObject({ variant: "success", message: expect.stringContaining("2 comments") })
  dispose()
})

test("a send that fails is retried under its first ID, before new drafts go in a message of their own", async () => {
  const { review, comment, states, prompts, respond, toasts, dispose } = setup()
  await comment("Use config")
  respond(async () => { throw new Error("Connection lost") })
  await review.send(SESSION, "This turn")
  expect(toasts.at(-1)).toMatchObject({ variant: "error", message: expect.stringContaining("Connection lost") })
  expect(states()).toEqual(["unconfirmed"])
  expect(drafts(review.review(SESSION))).toEqual([])

  await comment("And rename it", 5)
  respond(async () => ({}))
  await review.send(SESSION, "This turn")
  expect(prompts).toHaveLength(3)
  expect(prompts[1]!.id).toBe(prompts[0]!.id)
  expect(prompts[1]!.text).toContain("[r1]")
  expect(prompts[2]!.id).not.toBe(prompts[0]!.id)
  expect(prompts[2]!.text).toContain("[r2]")
  expect(prompts[2]!.text).not.toContain("[r1]")
  expect(states()).toEqual(["sent", "sent"])
  dispose()
})

test("when the second of two messages fails, only its comments are left to retry", async () => {
  const { review, comment, states, respond, toasts, dispose } = setup()
  await comment("Use config")
  respond(async () => { throw new Error("Connection lost") })
  await review.send(SESSION, "This turn")
  await comment("And rename it", 5)
  let calls = 0
  respond(async () => { if (++calls === 2) throw new Error("Connection lost again"); return {} })
  await review.send(SESSION, "This turn")
  expect(toasts.at(-1)).toMatchObject({ variant: "error", message: expect.stringContaining("(1 sent)") })
  expect(states()).toEqual(["sent", "unconfirmed"])
  dispose()
})

test("comments wait while queued, and become drafts again when their message is cancelled", async () => {
  const { review, comment, states, prompts, setPending, emit, dispose } = setup()
  await comment("Use config")
  await review.send(SESSION, "This turn")
  setPending([prompts[0]!.id!])
  expect(states()).toEqual(["pending"])

  emit("session.inbox.cancelled", { sessionID: SESSION, inboxID: prompts[0]!.id! })
  await settle()
  expect(drafts(review.review(SESSION)).map((item) => item.id)).toEqual(["r1"])
  dispose()
})

test("changes made in quick succession all land", async () => {
  const { review, comment, dispose } = setup()
  await Promise.all([comment("one"), comment("two", 5), comment("three", 6)])
  await review.removeComment(SESSION, "r2")
  expect(review.review(SESSION).comments.map((item) => [item.id, item.text])).toEqual([["r1", "one"], ["r3", "three"]])
  dispose()
})

test("replies are fetched after the agent's tools finish, only for sessions that were sent comments", async () => {
  const asked: string[] = []
  const { review, comment, emit, dispose } = setup(async (sessionID) => {
    asked.push(sessionID)
    return { r1: { status: "done", reply: "Moved to config.ts.", at: 2 } }
  })
  emit("session.tool.success", { sessionID: SESSION })
  await settle()
  expect(asked).toEqual([])

  await comment("Use config")
  await review.send(SESSION, "This turn")
  emit("session.tool.success", { sessionID: SESSION })
  emit("session.idle", { sessionID: SESSION })
  await settle()
  await settle()
  expect(asked).toEqual([SESSION])
  expect(review.repliesFor(SESSION)).toEqual({ r1: { status: "done", reply: "Moved to config.ts.", at: 2 } })
  dispose()
})
