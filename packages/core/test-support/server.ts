import type { SetTimer } from "../src/refresh"

type Handler = (input: unknown, call: { signal: AbortSignal; error(type: string, message: string, data: unknown): unknown }) => Promise<unknown>
type Cleanup = (() => Promise<void> | void) | void

/** An event a location announced. */
export interface Announced {
  readonly directory: string
  readonly name: string
  readonly data: unknown
}

/** Timers that never fire, so only calls do anything. */
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
export function transported<T>(value: T, path = "value"): T {
  if (value === undefined) throw new Error(`${path} is undefined`)
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) transported(item, `${path}.${key}`)
  return value === null || typeof value !== "object" ? value : JSON.parse(JSON.stringify(value))
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

const servers = new Set<{ close(): Promise<void> }>()

/**
 * Unloads every location of every fake server, so a process-wide service never outlives a test. Each test file
 * registers it with `afterEach`: this module loads once for every file.
 */
export async function closeServers() {
  for (const server of [...servers]) await server.close()
  servers.clear()
}

/**
 * A server plugin as the host runs it: an instance per location, started by the first call there, all sharing the
 * plugin's storage, with RPC handlers called as a client would and their results carried as JSON. Every subscriber
 * receives every location's events, live only. `faults` makes storage, or one location's storage and events, fail.
 */
export function fakeServer(options: {
  plugin: { setup(context: never): unknown }
  stored?: Map<string, unknown>
  options?: Record<string, unknown>
  /** More of each location's context, such as the session or event domains. */
  context?(directory: string): Record<string, unknown>
}) {
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
  const instances = new Map<string, Promise<{ handlers: Record<string, Handler>; cleanup: Cleanup }>>()
  const subscribers = new Set<{ push(event: Announced): void; end(): void }>()
  const events: Announced[] = []

  const instance = (directory: string) => {
    let loaded = instances.get(directory)
    if (!loaded) instances.set(directory, loaded = (async () => {
      let handlers: Record<string, Handler> = {}
      let disposed = false
      const context = {
        location: { directory }, options: options.options ?? {}, storage: storage(directory),
        rpc: { register: async (_definition: unknown, registered: Record<string, Handler>) => {
          handlers = { ...handlers, ...registered }
          return {
            events: { emit: async (name: string, data: unknown) => {
              if (disposed) throw new Error("Plugin unloaded")
              if (faults.locations.has(directory)) throw new Error("Host gone")
              const event = { directory, name, data: transported(data) }
              events.push(event)
              for (const subscriber of subscribers) subscriber.push(event)
            } },
            dispose: async () => { disposed = true },
          }
        } },
        ...options.context?.(directory),
      }
      const cleanup = await options.plugin.setup(context as never) as Cleanup
      return { handlers, cleanup }
    })())
    return loaded
  }

  const server = {
    stored,
    events,
    faults,
    /** Calls a method in `directory`'s location, starting its instance first if needed. */
    async call<T>(directory: string, method: string, input: unknown, signal = new AbortController().signal): Promise<T> {
      const { handlers } = await instance(directory)
      const handler = handlers[method]
      if (!handler) throw { type: "rpc.method_not_found", message: `No method ${method}` }
      return transported(await handler(transported(input), { signal, error: (type, message) => ({ type, message }) }) as T)
    },
    /** Every location's events from now on, until the signal aborts or `disconnect`. */
    subscribe(signal: AbortSignal): AsyncIterable<Announced> {
      return {
        async *[Symbol.asyncIterator]() {
          const queue: Announced[] = []
          let wake = () => {}
          let ended = false
          const subscriber = { push: (event: Announced) => { queue.push(event); wake() }, end: () => { ended = true; wake() } }
          subscribers.add(subscriber)
          signal.addEventListener("abort", subscriber.end, { once: true })
          try {
            while (!ended) {
              if (queue.length) yield queue.shift()!
              else await new Promise<void>((resolve) => { wake = resolve })
            }
          } finally { subscribers.delete(subscriber) }
        },
      }
    },
    /** Ends every subscription, as a dropped connection does. */
    disconnect() { for (const subscriber of subscribers) subscriber.end() },
    async unload(directory: string) {
      const loaded = instances.get(directory)
      instances.delete(directory)
      await (await loaded)?.cleanup?.()
    },
    async close() { for (const directory of [...instances.keys()]) await server.unload(directory) },
  }
  servers.add(server)
  return server
}
