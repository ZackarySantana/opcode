import type { OpenCodeEvent, SessionInfo } from "@opencode/client"
import { fakeServer } from "@opcode/core/test-support/server"
import plugin from "../src/index"
import type { AgentsState, Attention, ObserveInput } from "../src/agents"
import type { AgentsRemote } from "../src/rpc"
import { session } from "./fixtures"

export const event = (type: string, data: object, created = Date.now(), directory?: string) =>
  ({ type, data, created, ...directory ? { location: { directory } } : {} }) as unknown as OpenCodeEvent

export const finished = (id: string, idle: number, directory?: string): SessionInfo => ({ ...session(id, directory), time: { created: 1, updated: idle, idle } })

/**
 * An OpenCode server's sessions and live events, which every location's plugin instance reads: each location's stream
 * carries every location's events. `streams` counts the streams open per location.
 */
export function host(sessions: SessionInfo[]) {
  const subscribers = new Set<{ directory: string; push(event: OpenCodeEvent): void }>()
  const reads = { roots: 0 }
  const context = (directory: string) => ({
    session: {
      list: async (input: { parentID?: null } = {}) => {
        if (input.parentID === null) reads.roots++
        return { data: sessions.filter((info) => input.parentID !== null || !info.parentID), cursor: {} }
      },
      get: async ({ sessionID }: { sessionID: string }) => sessions.find((info) => info.id === sessionID) ?? Promise.reject(new Error("not found")),
      context: async () => [],
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }): AsyncIterable<OpenCodeEvent> => ({
        async *[Symbol.asyncIterator]() {
          const queue: OpenCodeEvent[] = []
          let wake = () => {}
          const subscriber = { directory, push: (event: OpenCodeEvent) => { queue.push(event); wake() } }
          subscribers.add(subscriber)
          const abort = () => wake()
          signal.addEventListener("abort", abort, { once: true })
          try {
            while (!signal.aborted) {
              if (queue.length) yield queue.shift()!
              else await new Promise<void>((resolve) => { wake = resolve })
            }
          } finally {
            subscribers.delete(subscriber)
            signal.removeEventListener("abort", abort)
          }
        },
      }),
    },
  })
  return {
    sessions,
    reads,
    context,
    emit(...events: OpenCodeEvent[]) { for (const value of events) for (const subscriber of subscribers) subscriber.push(value) },
    streams: () => [...subscribers].map((subscriber) => subscriber.directory),
  }
}

/** The sessions plugin on a fake server over `opencode`'s host, with `options` as the server's. */
export const sessionsServer = (opencode: ReturnType<typeof host>, options: Record<string, unknown> = {}) =>
  fakeServer({ plugin, options: { database: ":memory:", ...options }, context: opencode.context })

/** A terminal whose location is `directory`, on a fake server running the plugin. */
export function agentsRemote(server: ReturnType<typeof fakeServer>, directory = "/work/alpha"): AgentsRemote {
  const events = <T>(name: string, signal: AbortSignal): AsyncIterable<T> => ({
    async *[Symbol.asyncIterator]() {
      for await (const announced of server.subscribe(signal)) if (announced.name === name) yield announced.data as T
    },
  })
  return {
    state: (signal) => server.call<AgentsState>(directory, "agents", {}, signal),
    observe: (input: ObserveInput, signal) => server.call<AgentsState>(directory, "observe", input, signal),
    changes: (signal) => events<AgentsState>("agents", signal),
    attention: (signal) => events<Attention>("attention", signal),
  }
}

/** Each announced state's rows, as `id:state`. */
export const shown = (state: AgentsState | undefined) => state?.rows.map((row) => `${row.id}:${row.state}`)
