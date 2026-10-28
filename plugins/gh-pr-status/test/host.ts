import type { SetTimer } from "@opcode/core/refresh"
import type { Remote } from "../src/client"
import type { Runner } from "../src/gh"
import { serverPlugin } from "../src/index"
import type { PullRequestsState, SettingsChange } from "../src/model"
import type { FormattedFeedback } from "../src/rpc"
import { response, teams } from "./fixtures"

type Handler = (input: unknown, call: { signal: AbortSignal; error(type: string, message: string, data: unknown): unknown }) => Promise<unknown>

/** gh answering the pull request searches from the fixtures, counting them. */
export function ghRunner() {
  const searches: string[] = []
  const run: Runner = async (args) => {
    if (args.includes("graphql")) searches.push(args.join(" "))
    return { stdout: args.includes("graphql") ? response : teams, stderr: "", status: 0 }
  }
  return { run, searches }
}

/** Timers that never fire, so only calls refresh. */
export const stopped: SetTimer = () => () => {}

/** Timers that fire only when the test says, by delay. */
export function manualTimers() {
  const pending = new Set<{ run: () => void; ms: number }>()
  const timer: SetTimer = (run, ms) => { const entry = { run, ms }; pending.add(entry); return () => pending.delete(entry) }
  return {
    timer,
    pending: (ms: number) => [...pending].filter((entry) => entry.ms === ms).length,
    fire(ms: number) { for (const entry of [...pending].filter((entry) => entry.ms === ms)) { pending.delete(entry); entry.run() } },
  }
}

/** What the transport carries: JSON, which can't hold undefined, so the host's validation would reject it. */
function transported<T>(value: T, path = "value"): T {
  if (value === undefined) throw new Error(`${path} is undefined`)
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) transported(item, `${path}.${key}`)
  return value === null || typeof value !== "object" ? value : JSON.parse(JSON.stringify(value))
}

const servers = new Set<{ close(): Promise<void> }>()
/**
 * Unloads every location of every fake server, so the process-wide service never outlives a test. Each test file
 * registers it with `afterEach`: this module loads once for every file.
 */
export async function closeServers() {
  for (const server of [...servers]) await server.close()
  servers.clear()
}

/**
 * The server plugin as the host runs it: an instance per location, started by the first call there, all sharing the
 * plugin's storage. Every subscriber receives every location's events, live only. `faults` makes storage, or one
 * location's storage and events, fail.
 */
export function fakeServer(options: { run: Runner; stored?: Map<string, unknown>; options?: Record<string, unknown>; timer?: SetTimer }) {
  const stored = options.stored ?? new Map<string, unknown>()
  const faults = { get: false, set: false, locations: new Set<string>() }
  const storage = (directory: string) => ({
    get: async (key: string) => {
      if (faults.get || faults.locations.has(directory)) throw new Error("disk read failed")
      return stored.has(key) ? transported(stored.get(key)) : undefined
    },
    set: async (key: string, value: unknown) => {
      if (faults.set || faults.locations.has(directory)) throw new Error("disk full")
      stored.set(key, transported(value))
    },
  })
  const plugin = serverPlugin(options.run, options.timer ?? stopped)
  const instances = new Map<string, Promise<{ handlers: Record<string, Handler>; cleanup: () => Promise<void> | void }>>()
  const subscribers = new Set<{ push(state: PullRequestsState): void; end(): void }>()
  /** Every event, with the location that announced it. */
  const events: { directory: string; state: PullRequestsState }[] = []

  const instance = (directory: string) => {
    let loaded = instances.get(directory)
    if (!loaded) instances.set(directory, loaded = (async () => {
      let handlers: Record<string, Handler> = {}
      let disposed = false
      const ctx = {
        location: { directory }, options: options.options ?? {}, storage: storage(directory),
        rpc: { register: async (_definition: unknown, registered: Record<string, Handler>) => {
          handlers = registered
          return {
            events: { emit: async (_name: string, data: PullRequestsState) => {
              if (disposed) throw new Error("Plugin unloaded")
              if (faults.locations.has(directory)) throw new Error("Host gone")
              const state = transported(data)
              events.push({ directory, state })
              for (const subscriber of subscribers) subscriber.push(state)
            } },
            dispose: async () => { disposed = true },
          }
        } },
      }
      const cleanup = await plugin.setup(ctx as never)
      return { handlers, cleanup: cleanup ?? (() => {}) }
    })())
    return loaded
  }
  const call = async <T>(directory: string, method: string, input: unknown, signal = new AbortController().signal) =>
    transported(await (await instance(directory)).handlers[method]!(input, { signal, error: (type, message) => ({ type, message }) }) as T)

  const server = {
    stored,
    events,
    faults,
    /** A terminal whose location is `directory`. */
    remote(directory = "/home/me"): Remote {
      return {
        state: (signal) => call<PullRequestsState>(directory, "state", {}, signal),
        update: (change: SettingsChange) => call<PullRequestsState>(directory, "update", { settings: change }),
        refresh: () => call<PullRequestsState>(directory, "refresh", {}),
        feedback: (directory, signal) => call<FormattedFeedback>(directory, "feedback", {}, signal),
        changes: (signal) => ({
          async *[Symbol.asyncIterator]() {
            const queue: PullRequestsState[] = []
            let wake = () => {}
            let ended = false
            const subscriber = { push: (state: PullRequestsState) => { queue.push(state); wake() }, end: () => { ended = true; wake() } }
            subscribers.add(subscriber)
            signal.addEventListener("abort", subscriber.end, { once: true })
            try {
              while (!ended) {
                if (queue.length) yield queue.shift()!
                else await new Promise<void>((resolve) => { wake = resolve })
              }
            } finally { subscribers.delete(subscriber) }
          },
        }),
      }
    },
    /** Ends every subscription, as a dropped connection does. */
    disconnect() { for (const subscriber of subscribers) subscriber.end() },
    async unload(directory: string) {
      const loaded = instances.get(directory)
      instances.delete(directory)
      await (await loaded)?.cleanup()
    },
    async close() { for (const directory of [...instances.keys()]) await server.unload(directory) },
  }
  servers.add(server)
  return server
}

/** Waits until `check` passes, for work that settles over a few turns. */
export async function eventually(check: () => unknown, timeout = 3_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    try { return void await check() } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}
