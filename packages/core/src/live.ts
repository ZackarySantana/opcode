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
  /** `activity` reports anything the stream receives, including keepalives that yield no event. */
  subscribe: (signal: AbortSignal, activity: () => void) => AsyncIterable<T>
  handle: (event: T, signal: AbortSignal) => void | Promise<void>
  warn: (error: unknown, source: LiveWarning) => void
  /** Runs alongside each resubscription (not the first), e.g. to reconcile events missed while offline. */
  onReconnect?: (signal: AbortSignal) => unknown
  retryMilliseconds?: number
  /** Resubscribe after this long without activity, even if the stream never settles. Only for streams with keepalives. */
  idleMilliseconds?: number
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
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const activity = () => {
      if (options.idleMilliseconds === undefined || attempt.signal.aborted) return
      clearTimeout(watchdog)
      watchdog = setTimeout(() => attempt.abort(new Error("Event stream stalled")), options.idleMilliseconds)
    }
    // A stalled stream may ignore its signal, so waiting for the next event also ends when the attempt does.
    const stalled = new Promise<never>((_, reject) => attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason), { once: true }))
    void stalled.catch(() => {})
    try {
      iterator = options.subscribe(active, activity)[Symbol.asyncIterator]()
      activity()
      // Calling next starts a lazy subscription, so reconciliation never waits for an event.
      let next = iterator.next()
      void next.catch(() => {})
      if (reconnect && options.onReconnect) {
        const onReconnect = options.onReconnect
        reconciliation = Promise.resolve().then(() => onReconnect(active)).catch((error) => { if (!active.aborted) report(error, "reconnect") })
      }
      while (!signal.aborted) {
        const item = await Promise.race([next, stalled])
        activity()
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
      clearTimeout(watchdog)
      const stall = attempt.signal.aborted
      attempt.abort()
      try {
        const closing = Promise.resolve(iterator?.return?.()).catch(() => {})
        // A stalled iterator may never finish closing.
        if (!stall) await closing
      } catch { /* The attempt already reported its stream error. */ }
      await reconciliation
    }
    reconnect = true
    try { await sleep(options.retryMilliseconds ?? 1_000, signal) } catch { /* Aborted. */ }
  }
}
