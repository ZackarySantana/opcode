import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OpenCodeEvent } from "@opencode/client"
import serverPlugin from "../src/index.js"
import { CostLedger } from "../src/ledger.js"
import { usageFromMessage } from "../src/messages.js"
import { event, location, message, session, tokens } from "./fixtures.js"

type Handlers = Record<string, (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>>
const call = { signal: new AbortController().signal }

function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

test("server RPC owns storage, derives identities, allows same-project worktrees, and validates batches", async () => {
  let handlers!: Handlers
  let streamSignal!: AbortSignal
  const cleanup = await serverPlugin.setup({
    options: { database: ":memory:" }, location,
    rpc: { register: async (_definition: unknown, value: Handlers) => { handlers = value } },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => {
      streamSignal = signal
      return (async function* (): AsyncIterable<OpenCodeEvent> { await waitForAbort(signal) })()
    } },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({
      ...session, id: sessionID, projectID: sessionID === "foreign" ? "other-project" : session.projectID,
      location: { directory: "/work/another-worktree" },
    }) },
  } as never)
  if (!cleanup) throw new Error("Missing cleanup")
  try {
    expect(await handlers.status!({}, call)).toMatchObject({ projectID: session.projectID, lastImport: null })
    const batch = { sessionID: session.id, records: [usageFromMessage(message)] }
    await handlers.importBatch!(batch, call)
    await handlers.importBatch!(batch, call)
    expect(await handlers.dashboard!({ range: "all" }, call)).toMatchObject({ total: { cost: 0.5, messages: 1 }, projectOptions: [{ id: session.projectID, label: "another-worktree" }] })
    await expect(handlers.importBatch!({ ...batch, sessionID: "foreign" }, call)).rejects.toThrow("another project")
    await expect(handlers.importBatch!({ ...batch, records: Array(101).fill(batch.records[0]) }, call)).rejects.toThrow("Invalid import batch")
    await expect(handlers.dashboard!({ range: "year" }, call)).rejects.toThrow("Invalid date range")
    await handlers.completeImport!({}, call)
    expect(await handlers.status!({}, call)).toMatchObject({ lastImport: expect.any(Number) })
  } finally { await cleanup() }
  expect(streamSignal.aborted).toBe(true)
  await expect(handlers.dashboard!({ range: "all" }, call)).rejects.toThrow()
})

test("server lifetime cancels a pending RPC read before writing, then closes the ledger", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opcode-cost-server-"))
  const database = join(directory, "cost.sqlite")
  let handlers!: Handlers
  let readStarted!: () => void
  const started = new Promise<void>((resolve) => { readStarted = resolve })
  let readSignal!: AbortSignal
  const cleanup = await serverPlugin.setup({
    options: { database }, location,
    rpc: { register: async (_definition: unknown, value: Handlers) => { handlers = value } },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => (async function* (): AsyncIterable<OpenCodeEvent> { await waitForAbort(signal) })() },
    session: { get: async (_input: unknown, { signal }: { signal: AbortSignal }) => {
      readSignal = signal
      readStarted()
      await waitForAbort(signal)
      signal.throwIfAborted()
      return session
    } },
  } as never)
  if (!cleanup) throw new Error("Missing cleanup")
  try {
    const request = handlers.importBatch!({ sessionID: session.id, records: [usageFromMessage(message)] }, call)
    const outcome = request.then(() => false, () => true)
    await started
    await cleanup()
    expect(await outcome).toBe(true)
    expect(readSignal.aborted).toBe(true)
    const ledger = new CostLedger(database)
    expect(ledger.dashboard({ range: "all" }).total.messages).toBe(0)
    ledger.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("server live collection reaches the same RPC dashboard as imported records", async () => {
  let handlers!: Handlers
  let drained!: () => void
  const ready = new Promise<void>((resolve) => { drained = resolve })
  const cleanup = await serverPlugin.setup({
    options: { database: ":memory:" }, location,
    rpc: { register: async (_definition: unknown, value: Handlers) => { handlers = value } },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
      yield event("session.step.started", { sessionID: session.id, assistantMessageID: message.id, agent: "build", model: message.model, started: message.time.created })
      yield event("session.step.ended", { sessionID: session.id, assistantMessageID: message.id, cost: 3, tokens, finish: "stop" })
      drained()
      await waitForAbort(signal)
    })() },
    session: { get: async () => session, context: async () => [message] },
  } as never)
  if (!cleanup) throw new Error("Missing cleanup")
  try {
    await ready
    await handlers.importBatch!({ sessionID: session.id, records: [usageFromMessage(message)] }, call)
    expect(await handlers.dashboard!({ range: "all" }, call)).toMatchObject({ total: { cost: 3, messages: 1 } })
  } finally { await cleanup() }
})

test("authorized fork imports cannot replace an existing source ID but can persist fork-only messages and complete", async () => {
  let handlers!: Handlers
  const cleanup = await serverPlugin.setup({
    options: { database: ":memory:" }, location,
    rpc: { register: async (_definition: unknown, value: Handlers) => { handlers = value } },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => (async function* (): AsyncIterable<OpenCodeEvent> { await waitForAbort(signal) })() },
    session: { get: async ({ sessionID }: { sessionID: string }) => sessionID === "fork"
      ? { ...session, id: "fork", parentID: session.id, location: { directory: "/work/fork" } }
      : session },
  } as never)
  if (!cleanup) throw new Error("Missing cleanup")
  try {
    const usage = usageFromMessage(message)
    await handlers.importBatch!({ sessionID: session.id, records: [usage] }, call)
    const forkBatch = { sessionID: "fork", records: [
      { ...usage, messageID: "fork-before", cost: 1 },
      { ...usage, providerID: "other", modelID: "other", cost: 99, completedAt: usage.completedAt! + 1_000 },
      { ...usage, messageID: "fork-after", cost: 0.25 },
    ] }
    await handlers.importBatch!(forkBatch, call)
    await handlers.importBatch!(forkBatch, call)
    await handlers.completeImport!({}, call)
    expect(await handlers.status!({}, call)).toMatchObject({ lastImport: expect.any(Number) })
    expect(await handlers.dashboard!({ range: "all" }, call)).toMatchObject({
      total: { cost: 1.75, messages: 3 }, modelOptions: [{ id: "provider/model", label: "provider/model" }],
    })
  } finally { await cleanup() }
})

test("server-authorized cross-project session moves preserve IDs and do not block new records in the same import", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opcode-cost-move-"))
  const database = join(directory, "cost.sqlite")
  let actualSession = session
  const start = async (projectID: string, target: string) => {
    let handlers!: Handlers
    const cleanup = await serverPlugin.setup({
      options: { database },
      location: { ...location, directory: target, project: { ...location.project, id: projectID } },
      rpc: { register: async (_definition: unknown, value: Handlers) => { handlers = value } },
      event: { subscribe: ({ signal }: { signal: AbortSignal }) => (async function* (): AsyncIterable<OpenCodeEvent> { await waitForAbort(signal) })() },
      session: { get: async () => actualSession },
    } as never)
    if (!cleanup) throw new Error("Missing cleanup")
    return { handlers, cleanup }
  }
  let current = await start(session.projectID, session.location.directory)
  try {
    const usage = usageFromMessage(message)
    await current.handlers.importBatch!({ sessionID: session.id, records: [usage] }, call)
    await current.cleanup()
    // A session move preserves session/message IDs. Its next server lookup authorizes the new attribution.
    actualSession = { ...session, projectID: "destination", location: { directory: "/work/destination" } }
    current = await start(actualSession.projectID, actualSession.location.directory)
    await current.handlers.importBatch!({ sessionID: session.id, records: [
      { ...usage, messageID: "new-after-move", cost: 0.25 }, { ...usage, cost: 0 },
    ] }, call)
    expect(await current.handlers.dashboard!({ range: "all", projectID: session.projectID }, call)).toMatchObject({ total: { messages: 0 } })
    expect(await current.handlers.dashboard!({ range: "all", projectID: "destination" }, call)).toMatchObject({
      total: { messages: 2, cost: 0.75 }, projectOptions: [{ id: "destination", label: "destination" }],
    })
  } finally { await current.cleanup(); rmSync(directory, { recursive: true, force: true }) }
})
