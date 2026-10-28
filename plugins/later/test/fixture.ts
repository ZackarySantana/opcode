import type { SetTimer } from "@opcode/core/refresh"
import { fakeServer } from "@opcode/core/test-support/server"
import type { OpenCodeClient } from "@opencode/client"
import { createRemote, type Remote } from "../src/client"
import type { LaterItem, LaterState } from "../src/domain"
import { serverPlugin } from "../src/index"

type Tool = { name: string; execute(input: unknown, context: unknown): Promise<{ content: string }> }

/**
 * The server plugin as the host runs it, with the agent's tools and the context hook per location. Each session's ID
 * is the time it was created. `decide` answers permission requests.
 */
export function laterServer(options: { stored?: Map<string, unknown>; timer?: SetTimer } = {}) {
  const tools = new Map<string, Tool[]>()
  const hooks = new Map<string, (event: { sessionID: string; tools: Record<string, unknown> }) => Promise<void>>()
  const approvals: unknown[] = []
  let decide = async () => {}
  const server = fakeServer({
    plugin: serverPlugin(options.timer),
    ...options.stored ? { stored: options.stored } : {},
    context: (directory) => ({
      tool: { transform: async (edit: (editor: { add(tool: Tool): void }) => void) => edit({ add: (tool) => tools.set(directory, [...tools.get(directory) ?? [], tool]) }) },
      permission: { assert: async (input: unknown) => { approvals.push(input); await decide() } },
      session: {
        hook: async (_name: string, hook: typeof hooks extends Map<string, infer H> ? H : never) => { hooks.set(directory, hook) },
        get: async ({ sessionID }: { sessionID: string }) => ({ time: { created: Number(sessionID) } }),
      },
    }),
  })
  /** Loads the location's instance, as any call there does. */
  const load = (directory: string) => server.call(directory, "state", {}).catch(() => {})
  return {
    server,
    approvals,
    decide: (next: () => Promise<void>) => { decide = next },
    /** Runs an agent tool in `directory`'s location. */
    async tool(name: string, input: unknown, directory = "/home/me") {
      await load(directory)
      const tool = tools.get(directory)?.find((tool) => tool.name === name)
      return (await tool!.execute(input, { sessionID: "s", agent: "build", messageID: "m", id: "c" })).content
    },
    /** The tools a request in a session created at `created` lists. */
    async listed(created: number, directory = "/home/me") {
      await load(directory)
      const event = { sessionID: `${created}`, tools: Object.fromEntries(["read", ...tools.get(directory)!.map((tool) => tool.name)].map((name) => [name, {}])) }
      await hooks.get(directory)!(event)
      return Object.keys(event.tools)
    },
  }
}

/** Where the server runs a call that names no location. */
const serverDirectory = "/server"

/** What `client.rpc` gives a terminal: calls in the location it passes, or the server's own, and every location's events. */
export function rpcClient(server: ReturnType<typeof fakeServer>): Pick<OpenCodeClient, "rpc"> {
  const events = {
    subscribe: (name: string, { signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        for await (const event of server.subscribe(signal)) if (event.name === name) yield { data: event.data }
      },
    }),
  }
  const rpc = new Proxy({}, {
    get: (_target, method: string) => method === "events" ? events
      : (input: unknown, options: { location?: { directory: string }; signal?: AbortSignal }) =>
        server.call(options.location?.directory ?? serverDirectory, method, input, options.signal),
  })
  return { rpc: () => rpc } as never
}

/** A terminal whose location is `directory`, or a caller without one when it is null. */
export function remote(server: ReturnType<typeof fakeServer>, directory: string | null = "/home/me"): Remote {
  return createRemote(() => rpcClient(server), () => directory === null ? undefined : { directory })
}

/** The stored list, as the server reads it. */
export const read = (server: ReturnType<typeof fakeServer>, directory = "/home/me") => server.call<LaterState>(directory, "state", {})

export const messages = (state: Pick<LaterState, "active">) => state.active.map((item) => item.message)

export const find = (state: Pick<LaterState, "active" | "completed">, id: string): LaterItem =>
  [...state.active, ...state.completed].find((item) => item.id === id)!
