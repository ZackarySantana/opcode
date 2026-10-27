/** A minimal language server client over a child process's stdio, and a pool that keeps one running per directory and server. */

import { readFile as readDisk, realpath } from "node:fs/promises"
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Place } from "./references"
import { serverLabel, type Server } from "./servers"

interface LspPosition {
  readonly line: number
  readonly character: number
}

interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

export interface LspLocation {
  readonly uri: string
  readonly range: LspRange
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A JSON-RPC message with its `Content-Length` header, which counts bytes, not characters. */
export function frame(message: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(message))
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
  const framed = new Uint8Array(header.byteLength + body.byteLength)
  framed.set(header)
  framed.set(body, header.byteLength)
  return framed
}

function headerEnd(buffer: Uint8Array) {
  for (let index = 0; index + 3 < buffer.byteLength; index++)
    if (buffer[index] === 13 && buffer[index + 1] === 10 && buffer[index + 2] === 13 && buffer[index + 3] === 10) return index
  return -1
}

function join(chunks: readonly Uint8Array[]) {
  if (chunks.length === 1) return chunks[0]!
  const joined = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return joined
}

/** Splits a byte stream into messages as chunks arrive, holding a partial message, or a character split across chunks, for the next. */
export function createUnframer() {
  // A large body arrives over many chunks, so they're kept apart and joined once it's whole.
  let chunks: Uint8Array[] = []
  let size = 0
  /** The awaited body's length in bytes, once its header was read. */
  let body = -1
  return (chunk: Uint8Array): unknown[] => {
    chunks.push(chunk)
    size += chunk.byteLength
    const messages: unknown[] = []
    for (;;) {
      if (body < 0) {
        // Headers are short, so joining what's buffered until one ends costs little.
        const buffered = join(chunks)
        const end = headerEnd(buffered)
        chunks = [buffered]
        if (end < 0) break
        const length = Number(/content-length:\s*(\d+)/i.exec(decoder.decode(buffered.subarray(0, end)))?.[1])
        chunks = [buffered.subarray(end + 4)]
        size = chunks[0]!.byteLength
        // A header without a length can't be framed: drop it and look for the next.
        if (Number.isNaN(length)) continue
        body = length
      }
      if (size < body) break
      const buffered = join(chunks)
      try { messages.push(JSON.parse(decoder.decode(buffered.subarray(0, body)))) } catch {}
      chunks = [buffered.subarray(body)]
      size = chunks[0]!.byteLength
      body = -1
    }
    return messages
  }
}

type Link = { targetUri: string; targetRange: LspRange; targetSelectionRange?: LspRange }

/** A references or definition result, which may be one Location, several, or LocationLinks, as Locations. */
export function toLocations(result: unknown): LspLocation[] {
  const items = Array.isArray(result) ? result : result ? [result] : []
  return items.flatMap((item: Partial<LspLocation & Link>): LspLocation[] =>
    item.targetUri && (item.targetSelectionRange ?? item.targetRange) ? [{ uri: item.targetUri, range: (item.targetSelectionRange ?? item.targetRange)! }]
    : item.uri && item.range ? [{ uri: item.uri, range: item.range }]
    : [])
}

const languages: Readonly<Record<string, string>> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact",
  ".py": "python", ".pyi": "python", ".rs": "rust", ".rb": "ruby", ".c": "c", ".h": "c",
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".c++": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp", ".h++": "cpp",
  ".sh": "shellscript", ".bash": "shellscript", ".zsh": "shellscript",
}

/** The LSP language ID for a file, which most servers check before they analyze it. */
export const languageId = (file: string) => {
  const extension = extname(file).toLowerCase()
  return languages[extension] ?? extension.slice(1)
}

/** Settles with the promise, or rejects when the signal aborts first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((done, fail) => {
    if (signal.aborted) return fail(signal.reason)
    const abort = () => fail(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(done, fail).finally(() => signal.removeEventListener("abort", abort))
  })
}

/** The value at a dotted section of the server's settings, as `workspace/configuration` asks for it. */
function setting(settings: Readonly<Record<string, unknown>> | undefined, section: unknown) {
  if (typeof section !== "string" || !section) return settings ?? null
  let value: unknown = settings
  for (const key of section.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined
  return value ?? null
}

type Message = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
type Pending = { resolve(value: unknown): void; reject(error: unknown): void }
type Child = Bun.Subprocess<"pipe", "pipe", "ignore">

export type Kind = "usages" | "definition"
const methods: Readonly<Record<Kind, string>> = { usages: "textDocument/references", definition: "textDocument/definition" }

/** One running language server for one directory. */
class LanguageClient {
  private next = 1
  private readonly pending = new Map<number, Pending>()
  private readonly documents = new Map<string, { version: number; text: string }>()
  private alive = true
  /** Work the server reports in progress, such as loading the project, by token. */
  private readonly progress = new Set<string | number>()
  /** When progress last began or ended, or the first document was opened: activity the server may still be settling from. */
  private changed = 0
  private reported = false
  private opened = 0
  /** Whether a query completed: until one has, queries can wait on the server indexing the project. */
  queried = false
  readonly exited: Promise<void>

  private constructor(private readonly child: Child, readonly label: string, private readonly root: string, private readonly server: Server) {
    this.exited = child.exited.then(() => {
      this.alive = false
      for (const pending of this.pending.values()) pending.reject(new Error(`${label} exited`))
      this.pending.clear()
    })
    void this.read()
  }

  static async start(root: string, server: Server, timeout: number) {
    const label = serverLabel(server)
    let child: Child
    try { child = Bun.spawn([...server.command], { cwd: root, env: { ...process.env, ...server.env }, stdin: "pipe", stdout: "pipe", stderr: "ignore" }) }
    catch (error) { throw new Error(`${label} could not start: ${error instanceof Error ? error.message : String(error)}`) }
    const client = new LanguageClient(child, label, root, server)
    const uri = pathToFileURL(root).href
    try {
      await client.request("initialize", {
        processId: process.pid,
        clientInfo: { name: "opcode-review" },
        rootUri: uri,
        rootPath: root,
        workspaceFolders: [{ uri, name: basename(root) }],
        initializationOptions: server.initialization,
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          workspace: { configuration: true, workspaceFolders: true },
          // Servers report loading the project as progress, which tells when their answers are complete.
          window: { workDoneProgress: true },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false, willSave: false, willSaveWaitUntil: false },
            references: { dynamicRegistration: false },
            definition: { dynamicRegistration: false, linkSupport: true },
          },
        },
      }, undefined, timeout)
      client.notify("initialized", {})
    } catch (error) {
      client.kill()
      throw error
    }
    return client
  }

  private async read() {
    const unframe = createUnframer()
    const reader = this.child.stdout.getReader()
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
        for (const message of unframe(chunk.value)) this.receive(message as Message)
    } catch {}
  }

  private receive(message: Message) {
    if (!message || typeof message !== "object") return
    if (typeof message.method === "string") {
      if (message.method === "$/progress") this.track(message.params as { token?: string | number; value?: { kind?: string } })
      // The server's own requests wait on an answer; its notifications, such as diagnostics, don't matter here.
      if (message.id !== undefined) this.send({ jsonrpc: "2.0", id: message.id, result: this.answer(message.method, message.params) })
      return
    }
    const pending = typeof message.id === "number" && this.pending.get(message.id)
    if (!pending) return
    if (message.error) pending.reject(new Error(`${this.label}: ${message.error.message ?? "request failed"}`))
    else pending.resolve(message.result ?? null)
  }

  private track(params: { token?: string | number; value?: { kind?: string } } | undefined) {
    if (params?.token === undefined) return
    if (params.value?.kind === "begin") this.progress.add(params.token)
    else if (params.value?.kind === "end") this.progress.delete(params.token)
    else return
    this.reported = true
    this.changed = performance.now()
  }

  /** Answers the server's requests with what a client without those features would. */
  private answer(method: string, params: unknown) {
    if (method === "workspace/configuration") {
      const items = (params as { items?: { section?: unknown }[] } | undefined)?.items ?? []
      return items.map((item) => setting(this.server.initialization, item.section))
    }
    if (method === "workspace/workspaceFolders") return [{ uri: pathToFileURL(this.root).href, name: basename(this.root) }]
    return null
  }

  private send(message: object) {
    if (!this.alive) return
    try {
      this.child.stdin.write(frame(message))
      this.child.stdin.flush()
    } catch {}
  }

  notify(method: string, params?: unknown) {
    this.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params })
  }

  request(method: string, params: unknown, signal: AbortSignal | undefined, timeout: number) {
    if (!this.alive) return Promise.reject(new Error(`${this.label} exited`))
    const id = this.next++
    return new Promise<unknown>((done, fail) => {
      const settle = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", aborted)
        this.pending.delete(id)
      }
      const cancel = (error: unknown) => {
        settle()
        this.notify("$/cancelRequest", { id })
        fail(error)
      }
      const aborted = () => cancel(signal?.reason)
      const timer = setTimeout(() => cancel(new Error(`${this.label} timed out`)), timeout)
      if (signal?.aborted) return aborted()
      signal?.addEventListener("abort", aborted, { once: true })
      this.pending.set(id, { resolve: (value) => { settle(); done(value) }, reject: (error) => { settle(); fail(error) } })
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  /** Opens the document, or sends its new text when it changed on disk since, and marks it most recently used. */
  private sync(uri: string, text: string) {
    const open = this.documents.get(uri)
    this.documents.delete(uri)
    if (!open) {
      if (!this.opened) this.changed = this.opened = performance.now()
      this.documents.set(uri, { version: 1, text })
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageId(uri), version: 1, text } })
    } else if (open.text !== text) {
      const version = open.version + 1
      this.documents.set(uri, { version, text })
      this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] })
    } else this.documents.set(uri, open)
  }

  private close(uri: string) {
    this.documents.delete(uri)
    this.notify("textDocument/didClose", { textDocument: { uri } })
  }

  /**
   * Brings the server's open documents in line with the disk before a query on `uri`: servers answer from an open document's
   * text rather than the file's, so an edited one would put places at stale lines. Opens `uri` and keeps at most `limit` open.
   */
  async open(uri: string, text: string, readFile: (path: string) => Promise<string>, limit: number) {
    const others = [...this.documents.keys()].filter((open) => open !== uri)
    const texts = await Promise.all(others.map((open) => readFile(fileURLToPath(open)).catch(() => undefined)))
    others.forEach((open, index) => {
      const current = texts[index]
      if (current === undefined) this.close(open)
      else if (current !== this.documents.get(open)?.text) this.sync(open, current)
    })
    this.sync(uri, text)
    for (const oldest of this.documents.keys()) {
      if (this.documents.size <= limit) break
      this.close(oldest)
    }
  }

  /**
   * Waits until the server has loaded the project: no progress in flight, and none begun or ended for `settle` milliseconds.
   * A server that hasn't reported progress yet gets `grace` after its first document opened to begin. Resolves false when
   * it's still loading at the deadline.
   */
  async loaded(deadline: number, signal: AbortSignal, { settle, grace }: { settle: number; grace: number }) {
    for (;;) {
      signal.throwIfAborted()
      if (!this.alive) throw new Error(`${this.label} exited`)
      const now = performance.now()
      if (!this.progress.size && now - this.changed >= settle && (this.reported || now - this.opened >= grace)) return true
      if (now >= deadline) return false
      await Bun.sleep(Math.min(50, Math.max(1, deadline - now)))
    }
  }

  async locate(kind: Kind, uri: string, position: LspPosition, signal: AbortSignal, timeout: number) {
    const context = kind === "usages" ? { context: { includeDeclaration: true } } : {}
    return toLocations(await this.request(methods[kind], { textDocument: { uri }, position, ...context }, signal, timeout))
  }

  kill() {
    if (!this.alive) return
    try { this.child.kill() } catch {}
  }

  /** Asks the server to shut down and exit, and kills it if it doesn't in time. */
  async stop() {
    if (this.alive) {
      await this.request("shutdown", null, undefined, 1000).catch(() => {})
      this.notify("exit")
      await Promise.race([this.exited, Bun.sleep(1000)])
    }
    this.kill()
  }
}

/** The path relative to one of the roots, with forward slashes, or undefined when it's outside them all. */
function within(roots: readonly string[], path: string) {
  for (const root of roots) {
    const relativePath = relative(root, path)
    if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) return relativePath.split(sep).join("/")
  }
}

/** Places for the locations inside the root, each with its line's text, skipping duplicates, and the paths of those outside it. */
export async function toPlaces(roots: readonly string[], locations: readonly LspLocation[], readFile: (path: string) => Promise<string>): Promise<{ places: Place[]; outside: string[] }> {
  const files = new Map<string, Promise<string[]>>()
  const lines = (path: string) => {
    let read = files.get(path)
    if (!read) files.set(path, read = readFile(path).then((text) => text.split(/\r?\n/), () => []))
    return read
  }
  const seen = new Set<string>()
  const places: Place[] = []
  const outside = new Set<string>()
  for (const { uri, range } of locations) {
    let path: string
    try { path = fileURLToPath(uri) } catch { outside.add(uri); continue }
    const file = within(roots, path)
    if (file === undefined) { outside.add(path); continue }
    const line = range.start.line + 1
    const column = range.start.character
    const key = `${file}\0${line}\0${column}`
    if (seen.has(key)) continue
    seen.add(key)
    places.push({ file, line, column, text: (await lines(path))[range.start.line] ?? "" })
  }
  return { places, outside: [...outside] }
}

export interface PoolOptions {
  /** How long a query may take, in milliseconds. */
  readonly timeout?: number
  /** How long starting a server may take. */
  readonly startTimeout?: number
  /** How long a server's first query may take, while it indexes the project. */
  readonly firstTimeout?: number
  /** How long an unused server keeps running. */
  readonly idle?: number
  /** How long a server must report no progress before its project counts as loaded, in milliseconds. */
  readonly settle?: number
  /**
   * How long after opening its first file a server that hasn't reported progress counts as loading. Servers that report it
   * begin within a tenth of a second; typescript-language-server, made not to, answers incompletely for its first two seconds.
   */
  readonly grace?: number
  /** How many documents a server keeps open at once; it reads the rest from disk. */
  readonly open?: number
  readonly readFile?: (path: string) => Promise<string>
}

export interface Located {
  readonly places: Place[]
  /** Paths, or URIs that aren't files, of what the server found outside the root, such as a library's declarations. */
  readonly outside: string[]
  /** The server was still loading the project when it answered, so the places may be incomplete. */
  readonly partial: boolean
}

export interface Pool {
  /** Where the language server finds the symbol at `at` used or defined, as places relative to `root`. */
  locate(root: string, server: Server, kind: Kind, at: Omit<Place, "text">, signal: AbortSignal): Promise<Located>
  /** Stops every server. */
  dispose(): Promise<void>
}

/** Running language servers by directory and server, started on first use and stopped when idle, crashed, or disposed. */
export function createPool({ timeout = 8_000, startTimeout = 20_000, firstTimeout = 20_000, idle = 10 * 60_000, settle = 300, grace = 2_000, open = 16, readFile = (path) => readDisk(path, "utf8") }: PoolOptions = {}): Pool {
  type Entry = { spec: string; client: Promise<LanguageClient>; timer?: ReturnType<typeof setTimeout> }
  const entries = new Map<string, Entry>()
  let disposed = false

  const remove = (key: string, entry: Entry) => {
    clearTimeout(entry.timer)
    if (entries.get(key) === entry) entries.delete(key)
  }
  const stop = (key: string, entry: Entry) => {
    remove(key, entry)
    return entry.client.then((client) => client.stop(), () => {})
  }
  const touch = (key: string, entry: Entry) => {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => void stop(key, entry), idle)
    entry.timer.unref?.()
  }

  const client = (root: string, server: Server) => {
    const key = `${root}\0${server.name}`
    const spec = JSON.stringify(server)
    let entry = entries.get(key)
    // Edited config takes effect on the next query.
    if (entry && entry.spec !== spec) { void stop(key, entry); entry = undefined }
    if (!entry) {
      const started: Entry = { spec, client: LanguageClient.start(root, server, startTimeout) }
      entries.set(key, entry = started)
      // A server that crashed, or failed to start, starts over on the next query.
      started.client.then((client) => client.exited.then(() => remove(key, started)), () => remove(key, started))
    }
    touch(key, entry)
    return { key, entry }
  }

  return {
    async locate(root, server, kind, at, signal) {
      if (disposed) throw new Error("language servers are stopped")
      const path = resolve(root, at.file)
      if (within([root], path) === undefined) throw new Error(`${at.file} is outside ${root}`)
      const text = await readFile(path)
      const { key, entry } = client(root, server)
      const running = await abortable(entry.client, signal)
      const uri = pathToFileURL(path).href
      await running.open(uri, text, readFile, open)
      const deadline = performance.now() + (running.queried ? timeout : firstTimeout)
      try {
        // A server answers from what it has loaded so far, so asking mid-load finds only some usages.
        const loaded = await running.loaded(deadline, signal, { settle, grace })
        const locations = await running.locate(kind, uri, { line: at.line - 1, character: at.column }, signal, Math.max(timeout, deadline - performance.now()))
        running.queried = true
        // Servers may answer with the directory's real path, such as when it's reached through a symlink.
        const roots = [root, await realpath(root).catch(() => root)]
        return { ...await toPlaces(roots, locations, readFile), partial: !loaded }
      } finally {
        if (entries.get(key) === entry) touch(key, entry)
      }
    },
    async dispose() {
      disposed = true
      await Promise.all([...entries].map(([key, entry]) => stop(key, entry)))
    },
  }
}
