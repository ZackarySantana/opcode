import { expect, test } from "bun:test"
import { describeRpcError, guarded, object, toJson } from "../src/rpc"

const call = (signal = new AbortController().signal) => ({ signal, error: (type: string, message: string, data: unknown) => ({ type, message, data }) })

test("a failure is reported as a declared error with its message, classified when asked", async () => {
  expect(await guarded(call(), async () => 1)).toBe(1)
  await expect(guarded(call(), () => { throw new Error("disk full") })).rejects.toEqual({ type: "failed", message: "disk full", data: {} })
  const classify = (error: unknown) => error instanceof RangeError ? "stale" : "failed"
  await expect(guarded(call(), () => { throw new RangeError("moved on") }, classify)).rejects.toEqual({ type: "stale", message: "moved on", data: {} })
})

test("a call the client aborted rethrows the original error, not a failure", async () => {
  const controller = new AbortController()
  controller.abort()
  const reason = new DOMException("The operation was aborted.", "AbortError")
  await expect(guarded(call(controller.signal), () => { throw reason })).rejects.toBe(reason)
})

test("JSON leaves unset fields out, and closed objects allow only their properties", () => {
  expect(toJson({ a: 1, b: undefined, c: [{ d: undefined }] })).toEqual({ a: 1, c: [{}] })
  expect(Object.keys(toJson({ b: undefined }))).toEqual([])
  expect(object({ a: { type: "string" } }, ["a"])).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false })
})

test("a server without the plugin, or with another version, says what to do; other errors keep their message", () => {
  const plugin = { name: "GH PR Status", package: "@lidtop/opencode-gh-pr-status" }
  expect(describeRpcError({ type: "rpc.unavailable", message: "no" }, plugin)).toBe("The OpenCode server isn't running GH PR Status: add @lidtop/opencode-gh-pr-status to the server's plugins.")
  expect(describeRpcError({ type: "rpc.method_not_found", message: "no" }, plugin)).toBe("The OpenCode server runs another version of GH PR Status: update @lidtop/opencode-gh-pr-status there.")
  expect(describeRpcError({ type: "failed", message: "disk full" }, plugin)).toBe("disk full")
  expect(describeRpcError(new Error("offline"), plugin)).toBe("offline")
})
