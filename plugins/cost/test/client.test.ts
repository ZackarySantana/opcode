import { expect, test } from "bun:test"
import { createCostService } from "../src/client.js"
import { CostRpc } from "../src/rpc.js"
import { usageFromMessage } from "../src/messages.js"
import { message } from "./fixtures.js"

test("all dashboard/import operations use the connected client's RPC and explicit location/signal", async () => {
  const calls: Array<{ name: string; input: unknown; options: unknown }> = []
  const location = { directory: "/remote/project" }
  const signal = new AbortController().signal
  const invoke = (name: string) => async (input: unknown, options: unknown) => { calls.push({ name, input, options }); return {} }
  const client = { rpc: (definition: unknown) => {
    expect(definition).toBe(CostRpc)
    return { dashboard: invoke("dashboard"), time: invoke("time"), status: invoke("status"), importBatch: invoke("importBatch"), completeImport: invoke("completeImport") }
  } }
  const service = createCostService(client as never, location)
  await service.dashboard("7d", signal)
  await service.time("7d", signal)
  await service.status(signal)
  await service.importBatch({ sessionID: "s", records: [usageFromMessage(message)] }, signal)
  await service.completeImport(signal)
  expect(calls.map((call) => call.name)).toEqual(["dashboard", "time", "status", "importBatch", "completeImport"])
  expect(calls.slice(0, 2).map((call) => call.input)).toEqual([{ range: "7d" }, { range: "7d" }])
  for (const call of calls) expect(call.options).toEqual({ location, signal })
})
