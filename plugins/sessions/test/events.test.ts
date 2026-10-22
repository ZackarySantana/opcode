import { expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { sleep } from "@opcode/core/live"
import { watchSessions } from "../src/index"

const event = (type: string, sessionID = "s1", directory = "/work/alpha") => ({ type, data: { sessionID }, location: { directory } }) as OpenCodeEvent

test("event loop retries failed subscriptions, reconciles, and indexes moves/deletions", async () => {
  const controller = new AbortController()
  const finished = Promise.withResolvers<void>()
  const operations: string[] = []
  let subscriptions = 0
  const source = async function* (signal: AbortSignal) {
    if (++subscriptions === 1) throw new Error("disconnected")
    yield event("session.renamed", "foreign", "/other")
    yield event("session.moved", "moved", "/other")
    yield event("session.deleted", "deleted", "/other")
    await sleep(60_000, signal)
  }
  const task = watchSessions(source, {
    refresh: async () => { operations.push("refresh"); return { sessions: 0 } },
    syncSession: async (id) => { operations.push(`sync:${id}`) },
    remove: async (id) => { operations.push(`delete:${id}`); finished.resolve() },
  }, "/work/alpha", controller.signal, () => {}, 1)
  try {
    await finished.promise
    expect(subscriptions).toBe(2)
    expect(operations).toEqual(["refresh", "sync:moved", "delete:deleted"])
  } finally { controller.abort(); await task }
})

test("cancellation interrupts reconnect delay", async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const task = watchSessions(async function* () { throw new Error("offline") }, {
    refresh: async () => ({ sessions: 0 }), syncSession: async () => {}, remove: async () => {},
  }, "/work", controller.signal, () => started.resolve(), 60_000)
  await started.promise
  controller.abort()
  await task
})

test("restarting an idle open stream reconciles immediately without waiting for an event", async () => {
  const controller = new AbortController()
  const reconciled = Promise.withResolvers<void>()
  let subscriptions = 0
  let secondStarted = false
  const task = watchSessions(async function* (signal) {
    if (++subscriptions === 1) throw new Error("disconnected")
    secondStarted = true
    await sleep(60_000, signal)
  }, {
    refresh: async () => { expect(secondStarted).toBe(true); reconciled.resolve(); return { sessions: 0 } },
    syncSession: async () => {}, remove: async () => {},
  }, "/work", controller.signal, () => {}, 1)
  try {
    await Promise.race([reconciled.promise, sleep(500, controller.signal).then(() => { throw new Error("Idle stream never reconciled") })])
    expect(subscriptions).toBe(2)
  } finally { controller.abort(); await task }
})

test("a transient event indexing failure is retried without blocking stream consumption", async () => {
  const controller = new AbortController()
  let calls = 0
  const warnings: string[] = []
  const task = watchSessions(async function* (signal) {
    yield event("session.renamed")
    await sleep(60_000, signal)
  }, {
    refresh: async () => ({ sessions: 0 }), remove: async () => {},
    syncSession: async () => { if (++calls === 1) throw new Error("temporary"); controller.abort() },
  }, "/work/alpha", controller.signal, (warning) => warnings.push(warning), 1)
  await task
  expect(calls).toBe(2)
  expect(warnings).toHaveLength(1)
})
