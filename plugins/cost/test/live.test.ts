import { expect, test } from "bun:test"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { CostLedger } from "../src/ledger.js"
import { createLiveCollector } from "../src/live.js"
import { importProject } from "../src/importer.js"
import { context, event, location, message, record, serviceFor, session, tokens } from "./fixtures.js"

const started = { sessionID: session.id, assistantMessageID: message.id, agent: "build", model: message.model, started: message.time.created }
const ended = { sessionID: session.id, assistantMessageID: message.id, finish: "stop", cost: 0.5, tokens }

test("live steps are idempotent; absent-location events use actual session location/project", async () => {
  const ledger = new CostLedger(":memory:")
  let contextCalls = 0
  const host = {
    location,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessionID === "foreign" ? { ...session, location: { directory: "/elsewhere" } } : { ...session, projectID: "actual" },
      context: async () => { contextCalls++; return [message] },
    },
  }
  const collector = createLiveCollector(host, ledger)
  const signal = new AbortController().signal
  try {
    await collector.handle(event("session.step.started", started), signal)
    await collector.handle(event("session.step.ended", ended), signal)
    await collector.handle(event("session.step.ended", ended), signal)
    await collector.handle(event("session.step.ended", { ...ended, assistantMessageID: "ignored" }, { directory: "/elsewhere" }), signal)
    await collector.handle(event("session.step.ended", { ...ended, sessionID: "foreign" }, { directory: null }), signal)
    expect(contextCalls).toBe(1)
    expect(ledger.dashboard({ range: "all" }).total).toMatchObject({ cost: 0.5, messages: 1, tokens: 15 })
    expect(ledger.dashboard({ range: "all" }).projectOptions[0]?.id).toBe("actual")
  } finally { collector.clear(); ledger.close() }
})

test("failed steps retain reported usage and normalize missing usage", async () => {
  const ledger = new CostLedger(":memory:")
  const host = { location, session: { get: async () => session, context: async () => [message] } }
  const collector = createLiveCollector(host, ledger)
  const signal = new AbortController().signal
  try {
    await collector.handle(event("session.step.started", started), signal)
    await collector.handle(event("session.step.failed", { ...ended, error: { message: "provider error" } }), signal)
    await collector.handle(event("session.step.started", { ...started, assistantMessageID: "failed-empty" }), signal)
    await collector.handle(event("session.step.failed", { sessionID: session.id, assistantMessageID: "failed-empty", error: { message: "offline" } }), signal)
    expect(ledger.dashboard({ range: "all" }).total).toMatchObject({ cost: 0.5, messages: 2, tokens: 15 })
  } finally { collector.clear(); ledger.close() }
})

test("a retried step that fails without usage keeps earlier usage, and history import stays consistent", async () => {
  const ledger = new CostLedger(":memory:")
  const collector = createLiveCollector({ location, session: { get: async () => session, context: async () => [message] } }, ledger)
  const signal = new AbortController().signal
  try {
    await collector.handle(event("session.step.started", started), signal)
    await collector.handle(event("session.step.failed", { ...ended, cost: 0.3, error: { message: "overloaded" } }), signal)
    await collector.handle(event("session.step.started", started, { created: record.completedAt! + 1 }), signal)
    await collector.handle(event("session.step.failed", { sessionID: session.id, assistantMessageID: message.id, error: { message: "offline" } },
      { created: record.completedAt! + 2 }), signal)
    expect(ledger.dashboard({ range: "all" }).total).toMatchObject({ cost: 0.3, messages: 1, tokens: 15 })
    // The host keeps the earlier usage on its message, which history then re-reports.
    ledger.importBatch([{ ...record, cost: 0.3, completedAt: record.completedAt! + 2 }])
    expect(ledger.dashboard({ range: "all" }).total).toMatchObject({ cost: 0.3, messages: 1, tokens: 15 })
  } finally { collector.clear(); ledger.close() }
})

test("steps ended for another location release their pending start", async () => {
  const ledger = new CostLedger(":memory:")
  let contextCalls = 0
  const collector = createLiveCollector({ location, session: { get: async () => session, context: async () => { contextCalls++; return [message] } } }, ledger)
  const signal = new AbortController().signal
  try {
    await collector.handle(event("session.step.started", started), signal)
    await collector.handle(event("session.step.ended", ended, { directory: "/elsewhere" }), signal)
    await collector.handle(event("session.step.ended", ended), signal)
    // Without a retained start, the collector has to read the message from context.
    expect(contextCalls).toBe(1)
  } finally { collector.clear(); ledger.close() }
})

test("activation mid-step uses context and does not erase its usage on a usage-less failure", async () => {
  const ledger = new CostLedger(":memory:")
  const collector = createLiveCollector({ location, session: { get: async () => session, context: async () => [message] } }, ledger)
  try {
    await collector.handle(event("session.step.failed", { sessionID: session.id, assistantMessageID: message.id }), new AbortController().signal)
    expect(ledger.dashboard({ range: "all" }).total.cost).toBe(message.cost!)
  } finally { ledger.close() }
})

test("compaction accounting includes only completed modeled summaries", async () => {
  const ledger = new CostLedger(":memory:")
  const summary = { id: "summary", type: "compaction", status: "completed", reason: "auto", model: message.model,
    time: { created: message.time.created }, summary: "never stored", cost: 0.25, tokens } as const
  const host = { location, session: {
    get: async () => session,
    context: async () => [message, summary, { ...summary, id: "running", status: "running" as const }],
  } }
  const collector = createLiveCollector(host, ledger)
  try {
    await collector.handle(event("session.compaction.ended", { sessionID: session.id }), new AbortController().signal)
    expect(ledger.dashboard({ range: "all" }).total).toMatchObject({ cost: 0.25, messages: 1, tokens: 15 })
  } finally { ledger.close() }
})

test("cancelled session reads cannot write to the ledger", async () => {
  const ledger = new CostLedger(":memory:")
  const controller = new AbortController()
  const collector = createLiveCollector({ location, session: {
    get: async () => session,
    context: async () => { controller.abort(); return [message] },
  } }, ledger)
  try {
    await expect(collector.handle(event("session.step.ended", ended), controller.signal)).rejects.toThrow()
    expect(ledger.dashboard({ range: "all" }).total.messages).toBe(0)
  } finally { ledger.close() }
})

test("live turn markers match what history import records; subagents and synthetic wakes add no waits", async () => {
  const live = new CostLedger(":memory:")
  const imported = new CostLedger(":memory:")
  const child = { ...session, id: "child", parentID: session.id }
  const collector = createLiveCollector({ location, session: {
    get: async ({ sessionID }: { sessionID: string }) => sessionID === child.id ? child : session,
    context: async () => [message],
  } }, live)
  const signal = new AbortController().signal
  const start = record.createdAt
  const user = (inboxID: string, sessionID = session.id) => ({ sessionID, inboxID, item: { type: "user", payload: { text: "never stored" }, delivery: "steer" } })
  // History holds the same moments as user and idle messages.
  const history = [
    { id: "prompt", type: "user", text: "never stored", time: { created: start - 1_000 } },
    message,
    { id: "idle", type: "idle", outcome: "succeeded", time: { created: record.completedAt! + 1_000 } },
    { id: "wake", type: "synthetic", text: "subagent done", time: { created: start + 60_000 } },
  ]
  const client = {
    session: { list: async () => ({ data: [session, child], cursor: {} }) },
    message: { list: async ({ sessionID, type }: { sessionID: string; type: string }) => ({
      data: sessionID === session.id ? history.filter((item) => item.type === type) : [], cursor: {},
    }) },
  } as unknown as OpenCodeClient
  try {
    for (const [type, data, created] of [
      ["session.inbox.enqueued", user("prompt"), start - 1_000],
      ["session.inbox.delivered", { sessionID: session.id, inboxID: "prompt" }, start - 1_000],
      ["session.step.started", started, start],
      ["session.step.ended", ended, record.completedAt!],
      ["session.execution.succeeded", { sessionID: session.id }, record.completedAt! + 1_000],
      ["session.inbox.enqueued", { ...user("wake"), item: { type: "synthetic", payload: { text: "subagent done" }, delivery: "steer" } }, start + 60_000],
      ["session.inbox.delivered", { sessionID: session.id, inboxID: "wake" }, start + 60_000],
      ["session.inbox.enqueued", user("child", child.id), start],
      ["session.inbox.delivered", { sessionID: child.id, inboxID: "child" }, start],
      ["session.execution.succeeded", { sessionID: child.id }, start + 1_000],
    ] as const) await collector.handle(event(type, data, { created }), signal)
    await importProject(client, serviceFor(imported, [session, child]), signal)
    expect(live.time({ range: "all" }).total).toEqual({ agent: record.completedAt! + 1_000 - (start - 1_000), turns: 1, wait: 0, parallel: 0, peak: 1 })
    expect(imported.time({ range: "all" })).toEqual(live.time({ range: "all" }))
  } finally { collector.clear(); live.close(); imported.close() }
})
