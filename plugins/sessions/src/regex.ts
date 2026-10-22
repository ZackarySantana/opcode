import { createSerialQueue } from "@opcode/core"

/** Regex work runs outside the server thread and is terminated on budget expiry. */
export const MAX_QUERY = 256
export const MAX_SNIPPET = 4096
export interface Candidate { id: string; title: string; directory: string; messages: string[] }
/** `message` indexes the candidate's messages (-1 for a title/directory match); `at` is the match offset. */
export interface Match { id: string; message: number; at: number }
export class RegexTimeoutError extends Error {}

/** Unicode mode when the expression allows it; legacy syntax such as `\-` still works. */
export function compile(query: string) {
  const source = query.trim() || ".*"
  try { return new RegExp(source, "iu") } catch { return new RegExp(source, "i") }
}

/** Counts code points, like the RPC schema's `maxLength`. */
export function validateQuery(query: string) {
  if ([...query].length > MAX_QUERY) throw new Error(`Search expressions are limited to ${MAX_QUERY} characters.`)
  compile(query)
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
/** Nearest grapheme boundary in `direction`, inspecting only nearby text. */
function boundary(text: string, index: number, direction: 1 | -1) {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length))
  const from = Math.max(0, index - 32)
  let before = from
  let after: number | undefined
  for (const segment of graphemes.segment(text.slice(from, index + 32))) {
    const position = from + segment.index
    if (position <= index) before = position
    if (position >= index) { after = position; break }
  }
  let result = direction < 0 ? before : after ?? Math.min(text.length, index + 32)
  // Pathological clusters can exceed the window; never split a surrogate pair.
  const code = text.charCodeAt(result)
  if (result > 0 && result < text.length && code >= 0xdc00 && code <= 0xdfff) result += direction < 0 ? -1 : 1
  return result
}

/** A bounded window centered on the match, never splitting a grapheme. */
export function snippet(text: string, at = 0) {
  if (text.length <= MAX_SNIPPET) return text
  const start = boundary(text, Math.max(0, Math.min(at - MAX_SNIPPET / 2, text.length - MAX_SNIPPET)), 1)
  return text.slice(start, boundary(text, Math.min(text.length, start + MAX_SNIPPET), -1))
}

const program = `const compile = ${compile.toString()};
self.onmessage = ({ data }) => {
  try {
    const regex = compile(data.query);
    const matches = [];
    for (const row of data.rows) {
      let match;
      for (let message = 0; message < row.messages.length && !match; message++) {
        const at = row.messages[message].search(regex);
        if (at >= 0) match = { id: row.id, message, at };
      }
      // Fields are tested separately so anchors such as ^/home apply to each one.
      if (!match && (regex.test(row.title) || regex.test(row.directory))) match = { id: row.id, message: -1, at: 0 };
      if (match) { matches.push(match); if (matches.length >= data.limit) break; }
    }
    self.postMessage({ matches });
  } catch (error) { self.postMessage({ error: String(error) }); }
};`

/** One reusable worker; batches are serialized through it. */
export class RegexMatcher {
  private worker?: Worker
  private url?: string
  private readonly queue = createSerialQueue()
  constructor(private readonly timeout = 300) {}

  match(query: string, rows: Candidate[], limit: number, signal?: AbortSignal): Promise<Match[]> {
    validateQuery(query)
    return this.queue(() => this.run(query, rows, limit, signal))
  }

  private run(query: string, rows: Candidate[], limit: number, signal?: AbortSignal): Promise<Match[]> {
    signal?.throwIfAborted()
    if (!this.worker) {
      this.url = URL.createObjectURL(new Blob([program], { type: "application/javascript" }))
      this.worker = new Worker(this.url)
    }
    const worker = this.worker
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, matches?: Match[]) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        worker.onmessage = null
        worker.onerror = null
        // A cancelled or expired match may still be running; only termination stops it.
        if (error) { this.close(); reject(error) } else resolve(matches ?? [])
      }
      const abort = () => finish(signal?.reason ?? new Error("Search cancelled"))
      const timer = setTimeout(() => finish(new RegexTimeoutError("Search exceeded its regex time budget. Simplify the expression.")), this.timeout)
      signal?.addEventListener("abort", abort, { once: true })
      worker.onmessage = (event: MessageEvent<{ error?: string; matches: Match[] }>) => {
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
