import { expect, test } from "bun:test"
import { consumeLive, sleep, type LiveWarning } from "../src/live"

test("reconnects after errors and finished streams, reconciling only on reconnect, isolating event failures", async () => {
  const controller = new AbortController()
  const warnings: LiveWarning[] = []
  const handled: number[] = []
  const reconnects: number[] = []
  const reconcileReported = Promise.withResolvers<void>()
  let subscriptions = 0
  await consumeLive({
    signal: controller.signal, retryMilliseconds: 0,
    subscribe: () => {
      const attempt = ++subscriptions
      return (async function* () {
        if (attempt === 1) throw new Error("disconnected")
        if (attempt === 2) await reconcileReported.promise
        yield attempt
        if (attempt === 3) controller.abort()
      })()
    },
    handle: (event) => { handled.push(event); if (event === 2) throw new Error("bad event") },
    onReconnect: async () => { reconnects.push(subscriptions); if (subscriptions === 2) throw new Error("reconcile failed") },
    warn: (_error, source) => { warnings.push(source); if (source === "reconnect") reconcileReported.resolve() },
  })
  expect(subscriptions).toBe(3)
  expect(handled).toEqual([2, 3])
  expect(reconnects).toEqual([2, 3])
  expect(warnings.sort()).toEqual(["event", "reconnect", "stream", "stream"])
})

test("abort ends an idle subscription, returns its iterator, and cancels the retry delay", async () => {
  const controller = new AbortController()
  const subscribed = Promise.withResolvers<void>()
  let returned = false
  let streamSignal: AbortSignal | undefined
  const task = consumeLive({
    signal: controller.signal, retryMilliseconds: 60_000,
    subscribe: (signal) => {
      streamSignal = signal
      return (async function* () {
        try {
          subscribed.resolve()
          await sleep(60_000, signal)
          yield 1
        } finally { returned = true }
      })()
    },
    handle: () => {},
    warn: () => {},
  })
  await subscribed.promise
  controller.abort()
  await task
  expect(streamSignal?.aborted).toBe(true)
  expect(returned).toBe(true)
})

test("a failing warning reporter cannot reject the loop", async () => {
  const controller = new AbortController()
  const reconcileReported = Promise.withResolvers<void>()
  let subscriptions = 0
  await consumeLive({
    signal: controller.signal, retryMilliseconds: 0,
    subscribe: () => { if (++subscriptions === 2) controller.abort(); throw new Error("offline") },
    handle: () => {},
    warn: () => { throw new Error("reporter failed") },
  })
  expect(subscriptions).toBe(2)
})

test("sleep rejects with the abort reason", async () => {
  const controller = new AbortController()
  const pending = sleep(60_000, controller.signal)
  controller.abort(new Error("stopped"))
  await expect(pending).rejects.toThrow("stopped")
  await expect(sleep(0, AbortSignal.abort(new Error("already")))).rejects.toThrow("already")
})
