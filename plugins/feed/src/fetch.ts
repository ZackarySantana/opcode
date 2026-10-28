import { errorMessage } from "@opcode/core"
import type { SetTimer } from "@opcode/core/refresh"
import { parseFeed, type Feed } from "./parse"

export type Fetcher = (url: string, signal: AbortSignal) => Promise<string>

export const fetchText: Fetcher = async (url, signal) => {
  const response = await fetch(url, { signal, headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5" } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

export interface FetchOptions {
  /** Per attempt. */
  readonly timeout: number
  /** Waits before each retry of a failed fetch; it shows as unreachable once these run out. */
  readonly retryDelays: readonly number[]
  readonly timer: SetTimer
}

/** Resolves after `ms`, or as soon as the signal aborts. */
const wait = (timer: SetTimer, ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const cancel = timer(resolve, ms)
  signal.addEventListener("abort", () => { cancel(); resolve() }, { once: true })
})

/** Fetches and parses a feed, retrying after each of the delays; the last failure when they run out. */
export async function fetchFeed(fetcher: Fetcher, url: string, signal: AbortSignal, options: FetchOptions): Promise<{ feed: Feed } | { error: string }> {
  let failure: unknown
  for (const delay of [0, ...options.retryDelays]) {
    if (delay) await wait(options.timer, delay, signal)
    if (signal.aborted) break
    try {
      return { feed: parseFeed(await fetcher(url, AbortSignal.any([signal, AbortSignal.timeout(options.timeout)]))) }
    } catch (error) {
      failure = error
    }
  }
  return { error: errorMessage(failure) }
}
