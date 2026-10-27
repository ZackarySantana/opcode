/**
 * A language server for tests, speaking LSP over stdio with its own framing. It logs what it's sent as JSON lines to FAKE_LSP_LOG,
 * answers references with places in a.ts, b.ts, and outside its directory, and definition with a LocationLink into b.ts.
 * FAKE_LSP_HANG_AFTER stops answering queries after that many, FAKE_LSP_EMPTY answers with nothing, and FAKE_LSP_CRASH_ONCE exits on the first query
 * while the marker file it names doesn't exist yet. FAKE_LSP_LOAD takes that many milliseconds after the first file opens to load
 * the project, answering references with only the declaration meanwhile; FAKE_LSP_PROGRESS reports the loading as progress.
 * FAKE_LSP_OUTSIDE answers definition with a place outside its directory only, as for a standard library's declarations.
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const log = (entry: object) => { if (process.env.FAKE_LSP_LOG) appendFileSync(process.env.FAKE_LSP_LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n") }
const uri = (file: string) => pathToFileURL(join(process.cwd(), file)).href

// Writes each message in two pieces, splitting the header from part of the body, so the client must join chunks.
// One at a time, so pieces of messages sent together don't interleave.
let writing = Promise.resolve()
const send = (message: object) => writing = writing.then(() => write(message))
async function write(message: object) {
  const body = Buffer.from(JSON.stringify(message))
  const framed = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
  const middle = Math.floor(framed.length / 2)
  process.stdout.write(framed.subarray(0, middle))
  await Bun.sleep(1)
  process.stdout.write(framed.subarray(middle))
}

let opened = false
let answered = 0
let loading = false
function load() {
  const ms = Number(process.env.FAKE_LSP_LOAD)
  if (!ms) return
  loading = true
  const token = "load"
  const report = (value: object) => process.env.FAKE_LSP_PROGRESS && send({ jsonrpc: "2.0", method: "$/progress", params: { token, value } })
  if (process.env.FAKE_LSP_PROGRESS) void send({ jsonrpc: "2.0", id: "progress", method: "window/workDoneProgress/create", params: { token } })
  void report({ kind: "begin", title: "Loading" })
  setTimeout(() => { loading = false; void report({ kind: "end" }) }, ms)
}

const range = (line: number, character: number, length = 3) => ({ start: { line, character }, end: { line, character: character + length } })

async function receive(message: { id?: number | string; method?: string; params?: any; result?: unknown }) {
  if (message.method === undefined) return log({ event: "reply", id: message.id, result: message.result })
  if (message.method !== "initialized") log({ event: message.method, params: message.params })
  switch (message.method) {
    case "textDocument/didOpen":
      if (!opened) { opened = true; load() }
      return
    case "initialize":
      // Asks for settings the way servers like pyright do, before answering.
      await send({ jsonrpc: "2.0", id: "settings", method: "workspace/configuration", params: { items: [{ section: "fake.answer" }, { section: "missing" }] } })
      return send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { referencesProvider: true, definitionProvider: true, textDocumentSync: 1 } } })
    case "textDocument/references":
    case "textDocument/definition": {
      const marker = process.env.FAKE_LSP_CRASH_ONCE
      if (marker && !existsSync(marker)) { writeFileSync(marker, ""); process.exit(1) }
      if (process.env.FAKE_LSP_HANG_AFTER !== undefined && answered >= Number(process.env.FAKE_LSP_HANG_AFTER)) return
      answered++
      if (process.env.FAKE_LSP_EMPTY) return send({ jsonrpc: "2.0", id: message.id, result: null })
      const { line, character } = message.params.position
      const result = message.method === "textDocument/references"
        ? [{ uri: uri("a.ts"), range: range(line, character) }, ...loading ? [] : [{ uri: uri("b.ts"), range: range(1, 9) }, { uri: "file:///elsewhere/c.ts", range: range(0, 0) }]]
        : process.env.FAKE_LSP_OUTSIDE ? [{ uri: "file:///elsewhere/lib.d.ts", range: range(4, 2) }]
        : [{ targetUri: uri("b.ts"), targetRange: range(1, 0, 20), targetSelectionRange: range(1, 9) }]
      return send({ jsonrpc: "2.0", id: message.id, result })
    }
    case "shutdown":
      return send({ jsonrpc: "2.0", id: message.id, result: null })
    case "exit":
      return process.exit(0)
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n")
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())?.[1])
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString()
    buffer = buffer.subarray(end + 4 + length)
    void receive(JSON.parse(body))
  }
})
log({ event: "start" })
