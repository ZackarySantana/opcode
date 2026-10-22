import { expect, test } from "bun:test"
import type { ModelInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { buildSnapshot, estimateTokens } from "../src/snapshot"
import { user } from "./helpers"

const assistant: SessionMessageAssistant = {
  id: "assistant", type: "assistant", time: { created: 2 }, agent: "build", model: { providerID: "p", id: "old" },
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 40 } },
  content: [{ type: "reasoning", text: "r".repeat(40) }, {
    type: "tool", id: "tool", name: "read", time: { created: 2 },
    state: { status: "completed", input: { path: "not counted" }, content: [{ type: "text", text: "t".repeat(80) }] },
  }],
}
const compaction: SessionMessageInfo = { type: "compaction", id: "checkpoint", time: { created: 3 }, status: "completed", reason: "auto", summary: "summary" }
const model: ModelInfo = {
  id: "selected", modelID: "upstream", providerID: "p", name: "Selected model", capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 1000, output: 100 },
}

test("history telemetry, retained estimates, and selected model remain separate", () => {
  const snapshot = buildSnapshot({ sessionID: "s", messages: [user("u", "u".repeat(200)), assistant, assistant, compaction],
    retainedMessages: [assistant, compaction], model: { providerID: "p", id: "selected" }, models: [model] })
  expect(snapshot.usage).toEqual({ input: 100, cacheRead: 300, cacheWrite: 40, output: 20, reasoning: 5 })
  expect(snapshot.usageReports).toBe(1)
  expect(snapshot.messageCount).toEqual({ user: 1, assistant: 1 })
  expect(snapshot.toolCalls).toBe(1)
  expect(snapshot.compaction).toEqual({ count: 1, latestBoundary: "checkpoint" })
  expect(snapshot.retained?.estimatedTokens).toBe(32)
  expect(snapshot.retained?.contributors.map((item) => item.category)).toEqual(["tool", "reasoning", "system"])
  expect(snapshot.utilization).toBe(0.032)
  expect(snapshot.cacheEfficiency).toBe(300 / 440)
  expect(snapshot.model?.modelName).toBe("Selected model")
})

test("cache efficiency counts cache writes as recorded input", () => {
  const efficiency = (read: number, write: number) =>
    buildSnapshot({ messages: [{ ...assistant, tokens: { input: 100, output: 0, reasoning: 0, cache: { read, write } } }] }).cacheEfficiency
  expect(efficiency(300, 0)).toBe(0.75)
  expect(efficiency(300, 100)).toBe(0.6)
  expect(efficiency(0, 0)).toBe(0)
  expect(buildSnapshot({ messages: [] }).cacheEfficiency).toBeUndefined()
})

test("invalid provider usage values do not corrupt recorded totals", () => {
  const invalid = { ...assistant, id: "invalid", tokens: { input: NaN, output: -10, reasoning: Infinity, cache: { read: -1, write: 2 } } }
  const snapshot = buildSnapshot({ sessionID: "s", messages: [assistant, invalid] })
  expect(snapshot.usage).toEqual({ input: 100, cacheRead: 300, cacheWrite: 42, output: 20, reasoning: 5 })
  expect(snapshot.usageReports).toBe(2)
})

test("unknown retained context is distinct from an explicitly empty retained context", () => {
  const input = { messages: [assistant] }
  expect(buildSnapshot(input).retained).toBeUndefined()
  expect(buildSnapshot(input).utilizationProvenance).toBe("unavailable")
  expect(buildSnapshot({ ...input, retainedMessages: [] }).retained?.estimatedTokens).toBe(0)
})

test("streaming, failed tools, and attachments measure only observable metadata/output", () => {
  const messages: SessionMessageInfo[] = [{ ...assistant, tokens: undefined, content: [
    { type: "text", text: "😀" },
    { type: "tool", id: "running", name: "read", time: { created: 1 }, state: { status: "running", input: {}, metadata: {} } },
    { type: "tool", id: "error", name: "shell", time: { created: 1 }, state: { status: "error", input: {}, error: { type: "failure", message: "Oops" } } },
    { type: "tool", id: "file", name: "read", time: { created: 1 }, state: { status: "completed", input: {}, content: [{ type: "file", name: "image", mime: "image/png", uri: "file:///image" }] } },
  ] }, { ...user("u"), type: "user", text: "", files: [{ data: "PRIVATE-PAYLOAD", mime: "text/plain", name: "note", source: { type: "uri", uri: "file:///note" } }] }]
  const snapshot = buildSnapshot({ messages, retainedMessages: messages })
  expect(snapshot.usageReports).toBe(0)
  expect(snapshot.toolCalls).toBe(3)
  expect(snapshot.retained?.contributors.filter((item) => item.category === "file")).toHaveLength(2)
  expect(snapshot.retained?.contributors.find((item) => item.label === "Tool: shell")?.characters).toBe(4)
  expect(snapshot.retained?.contributors.find((item) => item.category === "assistant")).toMatchObject({ characters: 2, bytes: 4 })
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE-PAYLOAD")
})

test("system, skill, synthetic, and shell output contribute; failed compactions do not", () => {
  const messages: SessionMessageInfo[] = [compaction,
    { id: "system", type: "system", text: "system", time: { created: 1 } },
    { id: "synthetic", type: "synthetic", text: "synthetic", time: { created: 1 } },
    { id: "skill", type: "skill", skill: "testing", name: "Testing", text: "skill", time: { created: 1 } },
    { id: "shell", type: "shell", shellID: "shell", command: "echo hi", status: "exited", time: { created: 1 }, output: { output: "hi", cursor: 2, size: 2, truncated: false } },
    { id: "failed", type: "compaction", status: "failed", reason: "manual", error: { type: "failure", message: "no" }, time: { created: 1 } },
  ]
  const snapshot = buildSnapshot({ messages, retainedMessages: messages })
  expect(snapshot.retained?.contributors).toHaveLength(5)
  expect(snapshot.compaction.count).toBe(1)
})

test("environment rows are sorted and later metadata wins", () => {
  const snapshot = buildSnapshot({ messages: [], environment: [
    { category: "tool", name: "read" }, { category: "agent", name: "build", detail: "old" },
    { category: "agent", name: "build", detail: "new" },
  ] })
  expect(snapshot.environment).toEqual([{ category: "agent", name: "build", detail: "new" }, { category: "tool", name: "read" }])
})

test("estimation rounds per contributor and does not conceal over-limit estimates", () => {
  expect(estimateTokens("")).toBe(0)
  expect(estimateTokens("12345")).toBe(2)
  const tiny = buildSnapshot({ messages: [], retainedMessages: [user("one", "a"), user("two", "b")] })
  expect(tiny.retained?.characters).toBe(2)
  expect(tiny.retained?.estimatedTokens).toBe(2)
  const snapshot = buildSnapshot({ messages: [], retainedMessages: [user("large", "x".repeat(8000))], model: { providerID: "p", id: "selected" }, models: [model] })
  expect(snapshot.utilization).toBe(2)
})
