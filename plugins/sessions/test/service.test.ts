import { expect, test } from "bun:test"
import type { SessionMessageInfo, SessionsResponse } from "@opencode/client"
import { acquireIndex } from "../src/index-store"
import { SessionsService, type SessionSource } from "../src/service"
import { assistant, message, session } from "./fixtures"

function fixture() {
  const lease = acquireIndex(":memory:")
  const controller = new AbortController()
  const sessions = new Map([["s1", session()]])
  const messages = new Map<string, SessionMessageInfo[]>([["s1", [assistant()]]])
  const source: SessionSource = { session: {
    list: async (input) => ({ data: [...sessions.values()].filter((row) => !input?.directory || row.location.directory === input.directory), cursor: {} }),
    get: async ({ sessionID }) => {
      const row = sessions.get(sessionID)
      if (!row) throw { _tag: "SessionNotFoundError", sessionID, message: "Not found" }
      return structuredClone(row)
    },
    context: async ({ sessionID }) => structuredClone(messages.get(sessionID) ?? []),
  } }
  const service = new SessionsService(source, lease, controller.signal)
  return { lease, controller, sessions, messages, source, service, async [Symbol.asyncDispose]() { controller.abort(); await service.settled(); lease.release() } }
}

test("headless context and full-history imports coexist and repeated batches do not double usage", async () => {
  await using env = fixture()
  await env.service.refresh()
  const { token } = await env.service.begin({ sessionID: "s1", updatedAt: 100 })
  await env.service.import({ token, messages: [message("historic", "before compaction")] })
  await env.service.import({ token, messages: [message("historic", "before compaction")] })
  env.service.finish(token)
  await env.service.syncSession("s1")
  expect((await env.service.search({ query: "before compaction", showSubagents: false })).rows).toMatchObject([{ messageCount: 2, cost: 0.25, snippet: "before compaction" }])
})

test("revision-checked uploads cannot replace newer text or revive deleted sessions", async () => {
  await using env = fixture()
  await env.service.refresh()
  const { token } = await env.service.begin({ sessionID: "s1", updatedAt: 100 })
  env.sessions.set("s1", session("s1", "/work/alpha", 200))
  env.messages.set("s1", [assistant("m2", "new response")])
  await env.service.syncSession("s1")
  await expect(env.service.import({ token, messages: [{ ...message("m2", "old response"), role: "assistant" }] })).rejects.toThrow("changed")
  const next = await env.service.begin({ sessionID: "s1", updatedAt: 200 })
  await env.service.remove("s1")
  await expect(env.service.import({ token: next.token, messages: [message()] })).rejects.toThrow("changed")
  await env.service.syncSession("s1") // Even a delayed creation event cannot undo deletion.
  expect(env.lease.index.ids()).toEqual([])
})

test("refresh reconciles offline deletions but never treats moved sessions as deleted", async () => {
  await using env = fixture()
  await env.service.refresh()
  env.sessions.set("s1", session("s1", "/work/moved", 200))
  await env.service.refresh(undefined, "/work/alpha")
  expect((await env.service.search({ query: "", showSubagents: false })).rows[0]?.directory).toBe("/work/moved")
  expect(env.lease.index.deleted("s1")).toBe(false)
  env.sessions.delete("s1")
  const list = env.source.session.list
  env.source.session.list = async () => { throw new Error("unavailable") }
  await expect(env.service.refresh()).rejects.toThrow("unavailable")
  expect(env.lease.index.ids()).toEqual(["s1"])
  env.source.session.list = list
  await env.service.refresh()
  expect(env.lease.index.ids()).toEqual([])
})

test("context fetched across a revision change is retried, not written as the new revision", async () => {
  await using env = fixture()
  let calls = 0
  env.source.session.context = async () => {
    if (++calls === 1) { env.sessions.set("s1", session("s1", "/work/alpha", 200)); return [assistant("m2", "stale")] }
    return [assistant("m2", "fresh")]
  }
  await env.service.syncSession("s1")
  expect(calls).toBe(2)
  expect((await env.service.search({ query: "", showSubagents: false })).rows).toMatchObject([{ updatedAt: 200, snippet: "fresh" }])
})

test("refresh follows cursors and cancellation prevents writes after pending I/O", async () => {
  await using env = fixture()
  const inputs: unknown[] = []
  env.sessions.set("s2", session("s2"))
  env.source.session.list = async (input) => {
    inputs.push(input)
    return input?.cursor ? { data: [session("s2")], cursor: {} } : { data: [session()], cursor: { next: "next" } }
  }
  await env.service.refresh()
  expect(inputs).toEqual([{ limit: 100 }, { cursor: "next", limit: 100 }])
  const pending = Promise.withResolvers<SessionMessageInfo[]>()
  const entered = Promise.withResolvers<void>()
  env.source.session.context = async () => { entered.resolve(); return pending.promise }
  const cancel = new AbortController()
  const work = env.service.syncSession("s1", cancel.signal)
  await entered.promise
  cancel.abort()
  pending.resolve([assistant("late", "must not be stored")])
  await expect(work).rejects.toThrow()
  expect(await env.lease.index.search({ query: "must not", showSubagents: false })).toEqual([])
})

test("search and deletion interleave safely while a background refresh waits on enumeration", async () => {
  await using env = fixture()
  await env.service.refresh()
  const page = Promise.withResolvers<SessionsResponse>()
  const enumerating = Promise.withResolvers<void>()
  env.source.session.list = async () => { enumerating.resolve(); return page.promise }
  const refresh = env.service.refresh()
  await enumerating.promise
  try {
    const available = await Promise.race([
      env.service.search({ query: "", showSubagents: false }),
      new Promise<never>((_, reject) => { setTimeout(() => reject(new Error("Search blocked by enumeration")), 500).unref() }),
    ])
    expect(available.rows).toMatchObject([{ id: "s1", snippet: "JWT rotation completed" }])
    await env.service.remove("s1")
    page.resolve({ data: [session()], cursor: {} }) // A late page cannot undo the intervening deletion.
    await refresh
    expect((await env.service.search({ query: "", showSubagents: false })).rows).toEqual([])
  } finally { page.resolve({ data: [], cursor: {} }); await refresh }
})

test("slow context reads cannot block search or overwrite a newer concurrent session commit", async () => {
  await using env = fixture()
  await env.service.refresh()
  const context = Promise.withResolvers<SessionMessageInfo[]>()
  const reading = Promise.withResolvers<void>()
  let calls = 0
  env.source.session.context = async () => {
    if (++calls === 1) { reading.resolve(); return context.promise }
    return [assistant("m2", "newest recorded text")]
  }
  const stale = env.service.syncSession("s1")
  await reading.promise
  try {
    expect((await env.service.search({ query: "", showSubagents: false })).rows).toHaveLength(1)
    env.sessions.set("s1", session("s1", "/work/alpha", 200))
    await env.service.syncSession("s1")
    context.resolve([assistant("m2", "outdated text")])
    await stale
    expect((await env.service.search({ query: "", showSubagents: false })).rows).toMatchObject([{ updatedAt: 200, snippet: "newest recorded text" }])
  } finally { context.resolve([]); await stale }
})

test("shared location leases serialize writes and closing one does not close another", async () => {
  const first = acquireIndex(":memory:")
  const second = acquireIndex(":memory:")
  const order: number[] = []
  const gate = Promise.withResolvers<void>()
  const a = first.serial(async () => { order.push(1); await gate.promise; order.push(2) })
  const b = second.serial(async () => { order.push(3) })
  gate.resolve()
  await Promise.all([a, b])
  expect(order).toEqual([1, 2, 3])
  first.release()
  expect(second.index.ids()).toEqual([])
  second.release()
})
