/** Finds a name as a whole word in a directory's files, with ripgrep when it's installed, else git grep. */

import type { Place } from "./references"

export interface Output {
  readonly stdout: string
  readonly stderr: string
  readonly status: number
  /** The output was cut off at the byte limit. */
  readonly clipped: boolean
}

/** Runs a command in `cwd`, with `env` over this process's environment, reading at most `limit` bytes of its output before killing it. */
export type Runner = (argv: readonly string[], cwd: string, signal: AbortSignal, limit: number, env?: Readonly<Record<string, string>>) => Promise<Output>

export const runCommand: Runner = async (argv, cwd, signal, limit, env) => {
  const child = Bun.spawn([...argv], { cwd, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal })
  const chunks: Uint8Array[] = []
  let size = 0
  let clipped = false
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    chunks.push(chunk.value)
    size += chunk.value.byteLength
    // Common names can match millions of lines; stop reading well past what's shown.
    if (size >= limit) { clipped = true; child.kill(); break }
  }
  reader.releaseLock()
  const status = await child.exited
  signal.throwIfAborted()
  return { stdout: Buffer.concat(chunks).toString("utf8"), stderr: await stderr, status, clipped }
}

export interface Searched {
  readonly places: Place[]
  /** More matched than were returned. */
  readonly truncated: boolean
}

const order = (a: Place, b: Place) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column

const capped = (places: Place[], limit: number, truncated = false): Searched =>
  ({ places: places.sort(order).slice(0, limit), truncated: truncated || places.length > limit })

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The UTF-16 index in `text` of a UTF-8 byte offset, as ripgrep reports columns. */
export const utf16Index = (text: string, bytes: number) => decoder.decode(encoder.encode(text).subarray(0, bytes)).length

type Text = { text?: string }
type RipgrepEvent = { type?: string; data?: { path?: Text; lines?: Text; line_number?: number; submatches?: { start: number }[] } }

/** Places from `rg --json` output, one for each match on a line. Files or lines that aren't valid UTF-8 are skipped. */
export function parseRipgrep(stdout: string, limit: number, truncated = false): Searched {
  const places: Place[] = []
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue
    let event: RipgrepEvent
    try { event = JSON.parse(line) } catch { continue }
    const data = event.data
    if (event.type !== "match" || data?.path?.text === undefined || data.lines?.text === undefined || !data.line_number) continue
    const file = data.path.text.replace(/^\.\//, "").replaceAll("\\", "/")
    const text = data.lines.text.replace(/\r?\n$/, "")
    for (const { start } of data.submatches ?? []) places.push({ file, line: data.line_number, column: utf16Index(text, start), text })
  }
  return capped(places, limit, truncated)
}

/**
 * Places from `git grep -z -n --column` output, `file\0line\0column\0text` per line, whose column is 1-based and in bytes.
 * The NULs keep paths verbatim, even ones containing colons, digits, or line breaks.
 */
export function parseGitGrep(stdout: string, limit: number, truncated = false): Searched {
  const places: Place[] = []
  for (const [, file, number, column, text] of stdout.matchAll(/([^\0]+)\0(\d+)\0(\d+)\0([^\n]*)(?:\n|$)/g) as Iterable<[string, string, string, string, string]>) {
    const line = text.replace(/\r$/, "")
    places.push({ file, line: Number(number), column: utf16Index(line, Number(column) - 1), text: line })
  }
  return capped(places, limit, truncated)
}

export interface SearchOptions {
  readonly run?: Runner
  readonly which?: (command: string) => string | null
  /** The most places to return. */
  readonly limit?: number
  /** How long the search may take, in milliseconds. */
  readonly timeout?: number
  /** Variables for the search command, over this process's. */
  readonly env?: Readonly<Record<string, string>>
}

const BYTES = 8 * 1024 * 1024

/** Where `name` appears as a whole word in the directory's files, ignored files left out. */
export async function searchName(directory: string, name: string, signal: AbortSignal, { run = runCommand, which = (command) => Bun.which(command), limit = 1000, timeout = 10_000, env }: SearchOptions = {}): Promise<Searched> {
  const timed = AbortSignal.timeout(timeout)
  const combined = AbortSignal.any([signal, timed])
  const attempt = async <T>(search: () => Promise<T>) => {
    try { return await search() }
    catch (error) {
      if (timed.aborted && !signal.aborted) throw new Error("the search timed out")
      throw error
    }
  }
  // A cut-off output ends partway through a line.
  const whole = (output: Output) => output.clipped ? output.stdout.slice(0, output.stdout.lastIndexOf("\n") + 1) : output.stdout

  const rg = which("rg")
  if (rg) return await attempt(async () => {
    // No cap per file: it would drop matches without saying so. The overall limits report what they cut.
    const output = await run([rg, "--json", "-w", "-F", "--", name], directory, combined, BYTES, env)
    // 1 means no matches; 2 means some files couldn't be read, beside what matched in the rest.
    if (output.status > 1 && !output.stdout.trim()) throw new Error(output.stderr.trim() || `rg exited with ${output.status}`)
    return parseRipgrep(whole(output), limit, output.clipped)
  })

  const git = which("git")
  if (!git) throw new Error("searching needs ripgrep (rg) or git")
  return await attempt(async () => {
    const grep = (scope: readonly string[]) => run([git, "grep", "-z", "-n", "-w", "-F", "--column", "-I", ...scope, "--", name], directory, combined, BYTES, env)
    let output = await grep(["--untracked"])
    // Outside a repository, git grep searches the directory as plain files instead.
    if (output.status > 1 && /not a git repository/i.test(output.stderr)) output = await grep(["--no-index"])
    if (output.status > 1) throw new Error(output.stderr.trim() || `git grep exited with ${output.status}`)
    return parseGitGrep(whole(output), limit, output.clipped)
  })
}
