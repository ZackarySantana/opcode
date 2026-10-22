export type LiveWarning = "stream" | "event" | "reconnect"

/** Resolve after the delay, or reject with the abort reason as soon as the signal aborts. */
export function sleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const done = () => { signal?.removeEventListener("abort", abort); resolve() }
    const timer = setTimeout(done, milliseconds)
    const abort = () => { clearTimeout(timer); reject(signal!.reason) }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

/**
 * Consume a live-only subscription until aborted, reconnecting after errors or a finished stream.
 * Never rejects: stream, event, and reconnect failures are reported through `warn`.
 */
export async function consumeLive<T>(options: {
  signal: AbortSignal
  subscribe: (signal: AbortSignal) => AsyncIterable<T>
  handle: (event: T, signal: AbortSignal) => void | Promise<void>
  warn: (error: unknown, source: LiveWarning) => void
  /** Runs alongside each resubscription (not the first), e.g. to reconcile events missed while offline. */
  onReconnect?: (signal: AbortSignal) => unknown
  retryMilliseconds?: number
}) {
  const { signal } = options
  const report = (error: unknown, source: LiveWarning) => {
    if (signal.aborted) return
    try { options.warn(error, source) } catch { /* Reporting must not stop collection. */ }
  }
  let reconnect = false
  while (!signal.aborted) {
    const attempt = new AbortController()
    const active = AbortSignal.any([signal, attempt.signal])
    let iterator: AsyncIterator<T> | undefined
    let reconciliation: Promise<unknown> | undefined
    try {
      iterator = options.subscribe(active)[Symbol.asyncIterator]()
      // Calling next starts a lazy subscription, so reconciliation never waits for an event.
      let next = iterator.next()
      void next.catch(() => {})
      if (reconnect && options.onReconnect) {
        const onReconnect = options.onReconnect
        reconciliation = Promise.resolve().then(() => onReconnect(active)).catch((error) => { if (!active.aborted) report(error, "reconnect") })
      }
      while (!signal.aborted) {
        const item = await next
        if (item.done) break
        signal.throwIfAborted()
        next = iterator.next()
        void next.catch(() => {})
        try { await options.handle(item.value, active) } catch (error) { report(error, "event") }
      }
      if (!signal.aborted) throw new Error("Event stream ended")
    } catch (error) {
      report(error, "stream")
    } finally {
      attempt.abort()
      try { await iterator?.return?.() } catch { /* The attempt already reported its stream error. */ }
      await reconciliation
    }
    reconnect = true
    try { await sleep(options.retryMilliseconds ?? 1_000, signal) } catch { /* Aborted. */ }
  }
}
