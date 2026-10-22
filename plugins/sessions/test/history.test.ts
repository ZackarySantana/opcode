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
  const remote = remoteStub({ begin: async ({ sessionID }) => ({ current: false, token: sessionID }), import: async (input) => { uploads.push(input); return { accepted: input.messages.length } } })
  expect(await importHistory(client, remote, new AbortController().signal)).toEqual({ imported: 2, unchanged: 0, skipped: 0, oversized: 0 })
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

test("oversized messages are left out and counted, and later messages and sessions still import", async () => {
  const uploaded: string[] = []
  const client: HistorySource = {
    session: { list: async () => ({ data: [session("s1"), session("s2")], cursor: {} }) },
    message: { list: async ({ sessionID }) => ({ data: [user(`${sessionID}-large`, "x".repeat(1_048_577)), user(`${sessionID}-small`, "fits")], cursor: {} }) },
  }
  const remote = remoteStub({ import: async ({ messages }) => { uploaded.push(...messages.map((message) => message.id)); return { accepted: messages.length } } })
  expect(await importHistory(client, remote, new AbortController().signal)).toEqual({ imported: 2, unchanged: 0, skipped: 0, oversized: 2 })
  expect(uploaded).toEqual(["s1-small", "s2-small"])
})

test("deleted, changed, and already-imported sessions are skipped without stopping the pass", async () => {
  const listed: string[] = []
  const finished: Array<{ token: string; complete?: boolean }> = []
  const client: HistorySource = {
    session: { list: async () => ({ data: ["gone", "busy", "same", "late", "ok"].map((id) => session(id)), cursor: {} }) },
    message: { list: async ({ sessionID }) => { listed.push(sessionID); return { data: [user(`${sessionID}-message`)], cursor: {} } } },
  }
  const remote = remoteStub({
    begin: async ({ sessionID }) => {
      if (sessionID === "gone") throw { type: "missing", message: "deleted" }
      if (sessionID === "busy") throw { type: "stale", message: "changed" }
      return { current: sessionID === "same", token: sessionID }
    },
    import: async ({ token, messages }) => {
      if (token === "late") throw { type: "stale", message: "changed during import" }
      return { accepted: messages.length }
    },
    finish: async (input) => { finished.push(input) },
  })
  expect(await importHistory(client, remote, new AbortController().signal)).toEqual({ imported: 1, unchanged: 1, skipped: 3, oversized: 0 })
  expect(listed).toEqual(["late", "ok"])
  expect(finished).toEqual([{ token: "same", complete: false }, { token: "late", complete: false }, { token: "ok", complete: true }])
})

test("other failures stop the pass, and a failed release cannot mask them", async () => {
  const client: HistorySource = { session: { list: async () => ({ data: [session("s1"), session("s2")], cursor: {} }) }, message: { list: async () => ({ data: [user()], cursor: {} }) } }
  const remote = remoteStub({
    import: async () => { throw { type: "failed", message: "disk full" } },
    finish: async () => { throw new Error("connection closed") },
  })
  await expect(importHistory(client, remote, new AbortController().signal)).rejects.toMatchObject({ message: "disk full" })
})

test("a server that predates history revisions still imports and its rejected finish does not change the outcome", async () => {
  const client: HistorySource = {
    session: { list: async () => ({ data: [session("s1")], cursor: {} }) },
    message: { list: async ({ sessionID }) => ({ data: [user(`${sessionID}-message`, "text")], cursor: {} }) },
  }
  const remote = remoteStub({
    begin: async ({ sessionID }) => ({ token: sessionID }),
    finish: async (input) => { if ("complete" in input) throw new Error("additional property complete") },
  })
  expect(await importHistory(client, remote, new AbortController().signal)).toEqual({ imported: 1, unchanged: 0, skipped: 0, oversized: 0 })
})
