import { expect, test } from "bun:test"
import type { SessionMessagesResponse } from "@opencode/client"
import { createBrowser } from "../src/browser"
import type { SearchOutput, SessionResult } from "../src/domain"
import type { HistorySource } from "../src/history"
import { record, remoteStub, session, user } from "./fixtures"

function result(id: string): SessionResult {
  return { ...record(id), snippet: "text", messageCount: 1, modelCount: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}
const emptyClient: HistorySource = { session: { list: async () => ({ data: [], cursor: {} }) }, message: { list: async () => ({ data: [], cursor: {} }) } }

test("movement never searches again, and newer filters win over late async responses", async () => {
  const pending = Promise.withResolvers<SearchOutput>()
  let calls = 0
  const model = createBrowser(emptyClient, remoteStub({ search: async (input) => {
    calls++
    if (input.query === "slow") return pending.promise
    return { rows: [result("one"), result("two")], projects: [], truncated: false }
  } }))
  try {
    await model.load()
    model.move(1); model.move(1)
    expect(model.state().selected).toBe(1)
    expect(calls).toBe(1)
    const slow = model.filters({ query: "slow" })
    await model.filters({ query: "fast" })
    pending.resolve({ rows: [result("stale")], projects: [], truncated: false })
    await slow
    expect(model.state().query).toBe("fast")
    expect(model.state().rows.map((row) => row.id)).toEqual(["one", "two"])
    await model.filters({ query: "[" })
    expect(model.state().searchError).not.toBe("")
    await model.clear()
    expect(model.state().searchError).toBe("")
  } finally { await model.dispose() }
})

test("refresh actually synchronizes server state and imports connected-client history", async () => {
  const order: string[] = []
  const client: HistorySource = { session: { list: async () => { order.push("history"); return { data: [session()], cursor: {} } } }, message: { list: async () => ({ data: [user()], cursor: {} }) } }
  const model = createBrowser(client, remoteStub({
    refresh: async () => { order.push("server"); return { sessions: 1, deferred: 0, failed: 0 } },
    import: async () => { order.push("import"); return { accepted: 1 } },
    search: async () => { order.push("search"); return { rows: [], projects: [], truncated: false } },
  }))
  try { await model.refresh(); expect(order).toEqual(["server", "history", "import", "search"]) } finally { await model.dispose() }
})

test("only the first opening synchronizes; partial server failures still import history and are reported", async () => {
  const order: string[] = []
  const client: HistorySource = { session: { list: async () => { order.push("history"); return { data: [session()], cursor: {} } } }, message: { list: async () => ({ data: [user()], cursor: {} }) } }
  let server = async () => { order.push("server"); return { sessions: 3, deferred: 1, failed: 1 } }
  const model = createBrowser(client, remoteStub({ refresh: () => server() }))
  try {
    await model.activate()
    await model.refresh()
    expect(order).toEqual(["server", "history"])
    expect(model.state().syncError).toContain("1 session could not be indexed")
    expect(model.state().syncNotice).toContain("1 busy session will be indexed when idle")
    await model.activate()
    expect(order).toEqual(["server", "history"])
    server = async () => { order.push("server"); throw new Error("offline") }
    await model.refresh()
    expect(order).toEqual(["server", "history", "server", "history"])
    expect(model.state().syncError).toContain("offline")
  } finally { await model.dispose() }
})

test("unload aborts pending full-history work and prevents subsequent uploads", async () => {
  const started = Promise.withResolvers<void>()
  let aborted = false
  let uploaded = false
  const client: HistorySource = { session: { list: async (_input, options) => {
    started.resolve()
    return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => { aborted = true; reject(options.signal?.reason) }, { once: true }))
  } }, message: emptyClient.message }
  const model = createBrowser(client, remoteStub({ import: async () => { uploaded = true; return { accepted: 0 } } }))
  const work = model.refresh()
  await started.promise
  await model.dispose()
  await work
  expect(aborted).toBe(true)
  expect(uploaded).toBe(false)
})

test("a discarded connection's delayed history can never be uploaded to a replacement server", async () => {
  const started = Promise.withResolvers<void>()
  const page = Promise.withResolvers<SessionMessagesResponse>()
  const uploadsA: string[] = []
  const uploadsB: string[] = []
  const clientA: HistorySource = { session: { list: async () => ({ data: [session("server-a")], cursor: {} }) }, message: { list: async () => { started.resolve(); return page.promise } } }
  const clientB: HistorySource = { session: { list: async () => ({ data: [session("server-b")], cursor: {} }) }, message: { list: async () => ({ data: [user("b-message", "B private text")], cursor: {} }) } }
  const modelA = createBrowser(clientA, remoteStub({ import: async ({ messages }) => { uploadsA.push(...messages.map((message) => message.text)); return { accepted: messages.length } } }))
  const modelB = createBrowser(clientB, remoteStub({ import: async ({ messages }) => { uploadsB.push(...messages.map((message) => message.text)); return { accepted: messages.length } } }))
  const work = modelA.refresh()
  await started.promise
  const disposed = modelA.dispose()
  try {
    await modelB.refresh()
    page.resolve({ data: [user("a-message", "A private text")], cursor: {} })
    await disposed
    await work
    expect(uploadsA).toEqual([])
    expect(uploadsB).toEqual(["B private text"])
  } finally {
    page.resolve({ data: [], cursor: {} })
    await modelA.dispose()
    await modelB.dispose()
  }
})
