import { expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { CostLedger } from "../src/ledger.js"
import { createLiveCollector } from "../src/live.js"
import { context, event, location, message, record, session, tokens } from "./fixtures.js"

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
