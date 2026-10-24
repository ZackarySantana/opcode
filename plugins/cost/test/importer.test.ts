import { expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client"
import type { CostService } from "../src/client.js"
import { importProject } from "../src/importer.js"
import { CostLedger } from "../src/ledger.js"
import { context, message, serviceFor, session } from "./fixtures.js"

test("imports paginated history, other worktrees, compactions, and rescans despite old markers", async () => {
  const ledger = new CostLedger(":memory:")
  const other = { ...session, id: "other", location: { directory: "/work/tree" } }
  const service = serviceFor(ledger, [session, other])
  const calls: unknown[] = []
  let lists = 0
  const client = {
    session: { list: async (input: { cursor?: string }) => {
      lists++
      calls.push(input)
      return input.cursor ? { data: [other], cursor: {} } : { data: [session], cursor: { next: "sessions-next" } }
    } },
    message: { list: async (input: { sessionID: string; type?: string; cursor?: string }) => {
      calls.push(input)
      // Like the host, later pages are owned by the cursor; first-page filters can't be combined with it.
      if (input.cursor && input.type) throw new Error("cursor cannot be combined with filters")
      if (input.type === "compaction") return { data: [
        { id: `${input.sessionID}-summary`, type: "compaction", status: "completed", model: message.model,
          time: { created: message.time.created }, cost: 0.25, tokens: message.tokens },
        // Defensive: a server may ignore the type filter.
        { type: "compaction", status: "running" }, { type: "user", time: { created: message.time.created } },
      ], cursor: {} }
      return input.cursor
        ? { data: [{ ...message, id: `${input.sessionID}-old` }], cursor: {} }
        : { data: [{ ...message, id: `${input.sessionID}-new` }], cursor: { next: "messages-next" } }
    } },
  } as unknown as OpenCodeClient
  try {
    ledger.markImported(context.projectID, context.directory)
    await importProject(client, service, new AbortController().signal)
    await importProject(client, service, new AbortController().signal)
    expect(lists).toBe(4)
    expect(calls).toContainEqual({ project: context.projectID, cursor: "sessions-next", limit: 100 })
    expect(calls).toContainEqual({ sessionID: "other", cursor: "messages-next", limit: 100 })
    expect(calls).toContainEqual({ sessionID: "other", type: "compaction", limit: 100 })
    expect(ledger.dashboard("all").total).toMatchObject({ cost: 2.5, messages: 6 })
  } finally { ledger.close() }
})

for (const forkFirst of [false, true]) {
  test(`${forkFirst ? "fork-first" : "parent-first"} shared history bills once, imports fork-only records, and completes idempotent retries`, async () => {
    const ledger = new CostLedger(":memory:")
    const fork = { ...session, id: "fork", parentID: session.id, location: { directory: "/work/fork" } }
    const ordered = forkFirst ? [fork, session] : [session, fork]
    const firstOwner = ordered[0]!.id
    let retry = false
    const client = {
      session: { list: async () => ({ data: retry ? [...ordered].reverse() : ordered, cursor: {} }) },
      message: { list: async ({ sessionID }: { sessionID: string }) => {
        // A conflicting later snapshot from the other session must not replace the source row.
        const shared = retry && sessionID !== firstOwner
          ? { ...message, cost: 99, model: { providerID: "other", id: "other" },
            time: { ...message.time, completed: message.time.completed! + 1_000 } }
          : message
        return { data: sessionID === fork.id
          ? [{ ...message, id: "fork-before", cost: 1 }, shared, { ...message, id: "fork-after", cost: 0.25 }]
          : [shared], cursor: {} }
      } },
    } as unknown as OpenCodeClient
    const service = serviceFor(ledger, ordered)
    try {
      await importProject(client, service, new AbortController().signal)
      expect(ledger.lastImport(context.projectID)).toBeNumber()
      const initial = ledger.dashboard("all")
      expect(initial.total).toMatchObject({ cost: 1.75, messages: 3, tokens: 45 })
      retry = true
      await importProject(client, service, new AbortController().signal)
      await importProject(client, service, new AbortController().signal)
      expect(ledger.dashboard("all")).toEqual(initial)
      expect(ledger.lastImport(context.projectID)).toBeNumber()
    } finally { ledger.close() }
  })
}

test("failed partial imports retry without duplicate usage or false completion", async () => {
  const ledger = new CostLedger(":memory:")
  let fail = true
  const client = {
    session: { list: async () => ({ data: [session], cursor: {} }) },
    message: { list: async ({ cursor }: { cursor?: string }) => {
      if (cursor && fail) throw new Error("offline")
      return { data: [message], cursor: cursor ? {} : { next: "next" } }
    } },
  } as unknown as OpenCodeClient
  try {
    await expect(importProject(client, serviceFor(ledger), new AbortController().signal)).rejects.toThrow("offline")
    expect(ledger.lastImport(context.projectID)).toBeNull()
    expect(ledger.dashboard("all").total.messages).toBe(1)
    fail = false
    await importProject(client, serviceFor(ledger), new AbortController().signal)
    expect(ledger.lastImport(context.projectID)).toBeNumber()
    expect(ledger.dashboard("all").total.messages).toBe(1)
  } finally { ledger.close() }
})

test("splits oversized history pages into bounded RPC batches", async () => {
  const sizes: number[] = []
  let completed = false
  const client = {
    session: { list: async () => ({ data: [session], cursor: {} }) },
    message: { list: async ({ type }: { type: string }) => ({ data: type === "assistant" ? Array.from({ length: 205 }, (_, index) => ({ ...message, id: `m${index}` })) : [], cursor: {} }) },
  } as unknown as OpenCodeClient
  const service = {
    status: async () => ({ projectID: context.projectID }),
    importBatch: async ({ records }: { records: unknown[] }) => { sizes.push(records.length) },
    completeImport: async () => { completed = true },
  } as unknown as CostService
  await importProject(client, service, new AbortController().signal)
  expect(sizes).toEqual([100, 100, 5])
  expect(completed).toBe(true)
})

test("cancellation after a response prevents subsequent writes and completion", async () => {
  const controller = new AbortController()
  let writes = 0
  const client = {
    session: { list: async () => ({ data: [session], cursor: {} }) },
    message: { list: async (_input: unknown, options: { signal: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal)
      controller.abort()
      return { data: [message], cursor: {} }
    } },
  } as unknown as OpenCodeClient
  const service = {
    status: async () => ({ projectID: context.projectID }), importBatch: async () => { writes++ }, completeImport: async () => { writes++ },
  } as unknown as CostService
  await expect(importProject(client, service, controller.signal)).rejects.toThrow()
  expect(writes).toBe(0)
})

test("repeated pagination cursors fail rather than looping forever", async () => {
  const client = {
    session: { list: async () => ({ data: [], cursor: { next: "same" } }) },
  } as unknown as OpenCodeClient
  let completed = false
  const service = {
    status: async () => ({ projectID: context.projectID }), completeImport: async () => { completed = true },
  } as unknown as CostService
  await expect(importProject(client, service, new AbortController().signal)).rejects.toThrow("repeated a cursor")
  expect(completed).toBe(false)
})
