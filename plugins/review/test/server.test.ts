import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import server from "../src/index"
import { formatReview, TOOL_NAME } from "../src/message"
import type { Comment } from "../src/review"

/** The metadata the terminal sends with a review of these comments, so both sides are held to one contract. */
const review = (...ids: string[]) => formatReview(ids.map((id): Comment => ({ id, file: "a.ts", side: "new", start: 1, end: 1, quote: ["+a"], text: "x", created: 1 })), "This turn")!.metadata

type Hook = (event: Record<string, unknown>) => Promise<void>

/** The server plugin against in-memory storage, with its tool, hooks, and RPC handlers captured. */
async function setup(failing = { get: false, set: false }) {
  const stored = new Map<string, unknown>()
  const hooks = new Map<string, Hook>()
  const tools: { name: string; execute: (input: unknown, context: ToolContext) => Promise<{ content: string }> }[] = []
  let handlers: Record<string, (input: unknown, call: unknown) => Promise<unknown>> = {}
  const ctx = {
    storage: {
      get: async (key: string) => { if (failing.get) throw new Error("disk read failed"); return structuredClone(stored.get(key)) },
      set: async (key: string, value: unknown) => { if (failing.set) throw new Error("disk full"); stored.set(key, structuredClone(value)) },
    },
    tool: { transform: async (callback: (editor: { add(tool: never): void }) => void) => callback({ add: (tool) => tools.push(tool) }) },
    session: { hook: async (name: string, hook: Hook) => { hooks.set(name, hook) } },
    rpc: { register: async (_definition: unknown, registered: typeof handlers) => { handlers = registered; return { dispose() {} } } },
  } as unknown as Plugin.Context
  await server.setup(ctx)
  const tool = tools.find((candidate) => candidate.name === TOOL_NAME)!
  const listed = async (sessionID: string) => {
    const event = { sessionID, tools: { [TOOL_NAME]: {}, read: {} } as Record<string, unknown> }
    await hooks.get("context")!(event)
    return TOOL_NAME in event.tools
  }
  const prompt = (sessionID: string, metadata?: Record<string, unknown>) => hooks.get("prompt")!({ sessionID, prompt: { text: "" }, metadata })
  const reply = (sessionID: string, replies: unknown[]) => tool.execute({ replies }, { sessionID } as ToolContext)
  const replies = async (sessionID: string) => (await handlers.replies!({ sessionID }, { error: (type: string, message: string) => ({ type, message }) }) as { replies: Record<string, unknown> }).replies
  return { listed, prompt, reply, replies, failing }
}

test("the reply tool appears only once a session was sent review comments, and records replies the terminal can read", async () => {
  const { listed, prompt, reply, replies } = await setup()
  expect(await listed("ses_a")).toBe(false)

  // Other prompts don't count; a review message's metadata names its comments.
  await prompt("ses_a", { other: true })
  expect(await listed("ses_a")).toBe(false)
  await prompt("ses_a", review("r1", "r2"))
  expect(await listed("ses_a")).toBe(true)
  expect(await listed("ses_b")).toBe(false)

  const result = await reply("ses_a", [
    { id: "r1", status: "done", reply: " Moved it to config.ts. " },
    { id: "r9", status: "answered", reply: "?" },
  ])
  expect(result.content).toBe("Recorded 1 reply. No comment has id r9.")
  expect(await replies("ses_a")).toEqual({ r1: { status: "done", reply: "Moved it to config.ts.", at: expect.any(Number) } })
  expect(await replies("ses_b")).toEqual({})

  // A later reply to the same comment replaces the earlier one; a later review adds its comments.
  await prompt("ses_a", review("r3"))
  await reply("ses_a", [{ id: "r1", status: "declined", reply: "Kept it after all." }, { id: "r3", status: "answered", reply: "It guards the cache." }])
  expect(await replies("ses_a")).toMatchObject({ r1: { status: "declined" }, r3: { status: "answered" } })
})

test("concurrent replies to one session both land", async () => {
  const { prompt, reply, replies } = await setup()
  await prompt("ses_a", review("r1", "r2"))
  await Promise.all([reply("ses_a", [{ id: "r1", status: "done", reply: "a" }]), reply("ses_a", [{ id: "r2", status: "done", reply: "b" }])])
  expect(Object.keys(await replies("ses_a")).sort()).toEqual(["r1", "r2"])
})

test("storage failures never block a prompt or a request, and reach the terminal as the declared error", async () => {
  const warn = console.warn
  console.warn = () => {}
  try {
    const { listed, prompt, replies, failing } = await setup()
    failing.set = true
    await expect(prompt("ses_a", review("r1"))).resolves.toBeUndefined()
    failing.get = true
    // Unknown, so the tool stays: it rejects IDs it doesn't know anyway.
    expect(await listed("ses_a")).toBe(true)
    await expect(replies("ses_a")).rejects.toEqual({ type: "failed", message: "disk read failed" })
  } finally { console.warn = warn }
})
