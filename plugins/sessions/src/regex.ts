/** Regex work runs outside the server thread and is terminated on budget expiry. */
export const MAX_QUERY = 256
export interface Candidate { id: string; title: string; directory: string; messages: string[] }

export function validateQuery(query: string) {
  if (query.length > MAX_QUERY) throw new Error(`Search expressions are limited to ${MAX_QUERY} characters.`)
  new RegExp(query.trim() || ".*", "i")
}

const program = `self.onmessage = ({ data }) => {
  try {
    const regex = new RegExp(data.query.trim() || ".*", "i");
    const matches = [];
    for (const row of data.rows) {
      const snippet = row.messages.find(text => regex.test(text));
      if (snippet !== undefined || regex.test(row.title + "\\n" + row.directory)) {
        matches.push({ id: row.id, snippet: (snippet || "").slice(0, 4096) });
        if (matches.length >= data.limit) break;
      }
    }
    self.postMessage({ matches });
  } catch (error) { self.postMessage({ error: String(error) }); }
};`

export class RegexMatcher {
  private worker?: Worker
  private url?: string
  constructor(private readonly timeout = 300) {}

  async match(query: string, rows: Candidate[], limit: number, signal?: AbortSignal): Promise<Array<{ id: string; snippet: string }>> {
    validateQuery(query)
    signal?.throwIfAborted()
    if (!this.worker) {
      this.url = URL.createObjectURL(new Blob([program], { type: "application/javascript" }))
      this.worker = new Worker(this.url)
    }
    const worker = this.worker
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, matches?: Array<{ id: string; snippet: string }>) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        worker.onmessage = null
        worker.onerror = null
        if (error) { this.close(); reject(error) } else resolve(matches ?? [])
      }
      const abort = () => finish(signal?.reason ?? new Error("Search cancelled"))
      const timer = setTimeout(() => finish(new Error("Search exceeded its regex time budget. Simplify the expression.")), this.timeout)
      signal?.addEventListener("abort", abort, { once: true })
      worker.onmessage = (event: MessageEvent<{ error?: string; matches: Array<{ id: string; snippet: string }> }>) => {
        finish(event.data.error ? new Error(event.data.error) : undefined, event.data.matches)
      }
      worker.onerror = (event) => finish(new Error(event.message))
      worker.postMessage({ query, rows, limit })
    })
  }

  close() {
    this.worker?.terminate()
    if (this.url) URL.revokeObjectURL(this.url)
    this.worker = undefined
    this.url = undefined
  }
}
