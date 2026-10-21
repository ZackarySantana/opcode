import { expect, test } from "bun:test"
import { importHistory, type HistorySource } from "../src/history"
import type { MessageRecord } from "../src/domain"
import { assistant, remoteStub, session, user } from "./fixtures"

test("historical import follows both cursors, excludes controls, and sends bounded batches", async () => {
  const sessionInputs: unknown[] = []
  const messageInputs: unknown[] = []
  const uploads: Array<{ token: string; messages: MessageRecord[] }> = []
  const client: HistorySource = {
    session: { list: async (input) => {
      sessionInputs.push(input)
      return input?.cursor ? { data: [session("s2")], cursor: {} } : { data: [session()], cursor: { next: "sessions-next" } }
    } },
    message: { list: async (input) => {
      messageInputs.push(input)
      return input.cursor
        ? { data: [assistant(`${input.sessionID}-assistant`)], cursor: {} }
        : { data: [...Array.from({ length: 70 }, (_, n) => user(`${input.sessionID}-${n}`, `before compaction ${n}`)), { id: "control", type: "synthetic", text: "skip", time: { created: 1 } }], cursor: { next: "messages-next" } }
    } },
  }
  const remote = remoteStub({ begin: async ({ sessionID }) => ({ token: sessionID }), import: async (input) => { uploads.push(input); return { accepted: input.messages.length } } })
  expect(await importHistory(client, remote, new AbortController().signal)).toBe(2)
  expect(sessionInputs).toEqual([{ limit: 100 }, { limit: 100, cursor: "sessions-next" }])
  expect(messageInputs).toEqual([
    { sessionID: "s1", limit: 100, order: "asc" }, { sessionID: "s1", limit: 100, cursor: "messages-next" },
    { sessionID: "s2", limit: 100, order: "asc" }, { sessionID: "s2", limit: 100, cursor: "messages-next" },
  ])
  expect(uploads.map((batch) => batch.messages.length)).toEqual([32, 32, 6, 1, 32, 32, 6, 1])
  expect(uploads.every((batch) => batch.messages.every((message) => message.id.startsWith(batch.token)))).toBe(true)
})

test("cancellation stops subsequent pages and does not send cleanup requests to a new connection", async () => {
  const controller = new AbortController()
  let pages = 0
  let finished = false
  const client: HistorySource = { session: { list: async () => ({ data: [session()], cursor: {} }) }, message: { list: async () => {
    pages++
    return { data: [user()], cursor: { next: "next" } }
  } } }
  const remote = remoteStub({ import: async () => { controller.abort(); return { accepted: 1 } }, finish: async () => { finished = true } })
  await expect(importHistory(client, remote, controller.signal)).rejects.toThrow()
  expect(pages).toBe(1)
  expect(finished).toBe(false)
})

test("oversized historical messages fail explicitly rather than leaking or truncating text", async () => {
  let uploaded = false
  const client: HistorySource = { session: { list: async () => ({ data: [session()], cursor: {} }) }, message: { list: async () => ({ data: [user("large", "x".repeat(1_048_577))], cursor: {} }) } }
  await expect(importHistory(client, remoteStub({ import: async () => { uploaded = true; return { accepted: 1 } } }), new AbortController().signal)).rejects.toThrow("1 MiB")
  expect(uploaded).toBe(false)
})
