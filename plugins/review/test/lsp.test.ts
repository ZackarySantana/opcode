import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPool, createUnframer, frame, toLocations, type PoolOptions } from "../src/lsp"
import type { Server } from "../src/servers"

const fake = join(import.meta.dir, "fixtures", "fake-lsp.ts")
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

/** A directory with two files, the fake server for it, and a pool, all removed after the test. Timings are short unless a test needs one. */
function workspace(env: Record<string, string> = {}, options: PoolOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "review-lsp-"))
  writeFileSync(join(root, "a.ts"), "const foo = 1\nexport { foo }\n")
  writeFileSync(join(root, "b.ts"), "import { foo } from \"./a\"\nexport { foo }\n")
  const logPath = join(root, "log.jsonl")
  const server: Server = { name: "fake", command: [process.execPath, fake], env: { FAKE_LSP_LOG: logPath, ...env }, initialization: { fake: { answer: 42 } } }
  const pool = createPool({ timeout: 2000, startTimeout: 5000, firstTimeout: 2000, settle: 0, grace: 0, ...options })
  cleanups.push(async () => { await pool.dispose(); rmSync(root, { recursive: true, force: true }) })
  const log = (): { pid: number; event: string; params?: any; id?: string; result?: unknown }[] => {
    try { return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) } catch { return [] }
  }
  const usages = (signal: AbortSignal, file = "a.ts") => pool.locate(root, server, "usages", { file, line: 1, column: 6 }, signal)
  const synced = () => log().filter((entry) => entry.event.startsWith("textDocument/did")).map((entry) => [entry.event.slice("textDocument/".length), entry.params.textDocument.uri.split("/").pop(), entry.params.textDocument.version])
  return { root, server, pool, log, usages, synced }
}

const running = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

async function until(check: () => boolean, ms = 3000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(20)) if (check()) return
  throw new Error("timed out waiting")
}

const signal = () => new AbortController().signal

test("messages survive being split at any byte, and several arrive in one chunk", () => {
  const messages = [{ jsonrpc: "2.0", id: 1, result: { text: "naïve 名前 😀" } }, { jsonrpc: "2.0", method: "note", params: [] }]
  const bytes = new Uint8Array([...frame(messages[0]), ...frame(messages[1])])
  for (let split = 0; split <= bytes.byteLength; split++) {
    const unframe = createUnframer()
    expect([...unframe(bytes.subarray(0, split)), ...unframe(bytes.subarray(split))]).toEqual(messages)
  }
  const unframe = createUnframer()
  expect([...bytes].flatMap((byte) => unframe(new Uint8Array([byte])))).toEqual(messages)
})

test("definition results come as one Location, several, or LocationLinks preferring the name's range", () => {
  const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
  const whole = { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } }
  expect(toLocations(null)).toEqual([])
  expect(toLocations({ uri: "file:///a", range })).toEqual([{ uri: "file:///a", range }])
  expect(toLocations([{ targetUri: "file:///b", targetRange: whole, targetSelectionRange: range }, { targetUri: "file:///c", targetRange: whole }]))
    .toEqual([{ uri: "file:///b", range }, { uri: "file:///c", range: whole }])
})

test("a pool starts one server per directory, answers with places inside it, and sends a changed file's new text", async () => {
  const { root, server, pool, log, usages, synced } = workspace()
  expect(await usages(signal())).toEqual({ places: [
    { file: "a.ts", line: 1, column: 6, text: "const foo = 1" },
    { file: "b.ts", line: 2, column: 9, text: "export { foo }" },
  ], outside: ["/elsewhere/c.ts"], partial: false })
  expect((await pool.locate(root, server, "definition", { file: "b.ts", line: 2, column: 9 }, signal())).places).toEqual([{ file: "b.ts", line: 2, column: 9, text: "export { foo }" }])

  writeFileSync(join(root, "a.ts"), "let foo = 2\nexport { foo }\n")
  expect((await usages(signal())).places[0]).toEqual({ file: "a.ts", line: 1, column: 6, text: "let foo = 2" })

  const events = log()
  expect(new Set(events.map((entry) => entry.pid)).size).toBe(1)
  expect(events.filter((entry) => entry.event === "start")).toHaveLength(1)
  const initialize = events.find((entry) => entry.event === "initialize")!.params
  expect(initialize).toMatchObject({ rootUri: Bun.pathToFileURL(root).href, initializationOptions: { fake: { answer: 42 } } })
  // Settings come from the server's initialization config, by section.
  expect(events.find((entry) => entry.id === "settings")?.result).toEqual([42, null])
  expect(synced()).toEqual([["didOpen", "a.ts", 1], ["didOpen", "b.ts", 1], ["didChange", "a.ts", 2]])
  expect(events.find((entry) => entry.event === "textDocument/references")?.params).toMatchObject({ position: { line: 0, character: 6 }, context: { includeDeclaration: true } })

  // Disposing asks the server to shut down and exit.
  const pid = events[0]!.pid
  await pool.dispose()
  expect(log().slice(-2).map((entry) => entry.event)).toEqual(["shutdown", "exit"])
  await until(() => !running(pid))
  await expect(usages(signal())).rejects.toThrow("stopped")
})

test("a server that crashed starts again on the next query", async () => {
  const marker = join(tmpdir(), `review-crash-${crypto.randomUUID()}`)
  cleanups.push(() => rmSync(marker, { force: true }))
  const { log, usages } = workspace({ FAKE_LSP_CRASH_ONCE: marker })
  await expect(usages(signal())).rejects.toThrow(/exited/)
  expect((await usages(signal())).places).toHaveLength(2)
  const starts = log().filter((entry) => entry.event === "start")
  expect(starts).toHaveLength(2)
  expect(starts[0]!.pid).not.toBe(starts[1]!.pid)
})

test("queries get the first query's longer budget until one completes, and are cancelled on the server when they give up", async () => {
  const firstTimeout = 300
  const hanging = workspace({ FAKE_LSP_HANG_AFTER: "0" }, { firstTimeout, timeout: 20 })
  const sent = (event: string) => hanging.log().filter((entry) => entry.event === event).length
  const controller = new AbortController()
  const query = hanging.usages(controller.signal)
  await until(() => sent("textDocument/references") === 1)
  controller.abort(new Error("moved on"))
  await expect(query).rejects.toThrow("moved on")
  // The aborted query didn't complete, so this one still waits as long as a first query may.
  const started = Date.now()
  await expect(hanging.usages(signal())).rejects.toThrow(/timed out/)
  expect(Date.now() - started).toBeGreaterThanOrEqual(firstTimeout - 20)
  await until(() => sent("$/cancelRequest") === 2)

  // Once one has completed, a hanging query gives up well before a first query would.
  const answered = workspace({ FAKE_LSP_HANG_AFTER: "1" }, { firstTimeout: 5000, timeout: 20 })
  await answered.usages(signal())
  const later = Date.now()
  await expect(answered.usages(signal())).rejects.toThrow(/timed out/)
  expect(Date.now() - later).toBeLessThan(5000)
})

test("the first query waits until the server reports it finished loading the project", async () => {
  // A long grace shows that the end of the progress, not the grace, lets the query through.
  const load = 150, grace = 5000
  const { log, usages } = workspace({ FAKE_LSP_LOAD: String(load), FAKE_LSP_PROGRESS: "1" }, { settle: 20, grace })
  const started = Date.now()
  expect(await usages(signal())).toMatchObject({ places: { length: 2 }, partial: false })
  expect(Date.now() - started).toBeGreaterThanOrEqual(load)
  expect(Date.now() - started).toBeLessThan(grace)
  expect(log().find((entry) => entry.id === "progress")).toMatchObject({ event: "reply", result: null })
})

test("a server still loading at the first query's deadline answers, marked partial", async () => {
  const { usages } = workspace({ FAKE_LSP_LOAD: "3000", FAKE_LSP_PROGRESS: "1" }, { grace: 50, firstTimeout: 200, timeout: 1000 })
  expect(await usages(signal())).toMatchObject({ places: { length: 1 }, partial: true })
})

test("a server that never reports progress gets a grace period after its first file opens", async () => {
  const grace = 200
  const { usages } = workspace({ FAKE_LSP_LOAD: "100" }, { grace })
  const started = Date.now()
  expect(await usages(signal())).toMatchObject({ places: { length: 2 }, partial: false })
  expect(Date.now() - started).toBeGreaterThanOrEqual(grace)
})

test("a server unused for its idle time is stopped", async () => {
  const { log, usages } = workspace({}, { idle: 100 })
  await usages(signal())
  const pid = log()[0]!.pid
  await until(() => !running(pid))
  expect(log().map((entry) => entry.event)).toContain("exit")
})

test("files outside the directory aren't opened", async () => {
  const { root, server, pool, log } = workspace()
  await expect(pool.locate(root, server, "usages", { file: "../etc/passwd", line: 1, column: 0 }, signal())).rejects.toThrow("outside")
  expect(log()).toEqual([])
})

test("files the server has open are brought up to date before each query, and only the most recently used stay open", async () => {
  const { root, usages, synced } = workspace({}, { open: 2 })
  writeFileSync(join(root, "c.ts"), "export const foo = 3\n")
  await usages(signal(), "a.ts")
  await usages(signal(), "b.ts")
  // An edit to a file opened earlier reaches the server before a query on another file, so its places aren't at stale lines.
  writeFileSync(join(root, "a.ts"), "\nconst foo = 1\nexport { foo }\n")
  await usages(signal(), "b.ts")
  expect(synced().slice(2)).toEqual([["didChange", "a.ts", 2]])
  await usages(signal(), "c.ts")
  expect(synced().slice(3)).toEqual([["didOpen", "c.ts", 1], ["didClose", "a.ts", undefined]])
  // A file deleted since is closed rather than kept open with its old text.
  rmSync(join(root, "b.ts"))
  await usages(signal(), "c.ts")
  expect(synced().slice(5)).toEqual([["didClose", "b.ts", undefined]])
})

test("places outside the directory are left out but reported, such as a definition in a library", async () => {
  const { root, server, pool } = workspace({ FAKE_LSP_OUTSIDE: "1" })
  expect(await pool.locate(root, server, "definition", { file: "a.ts", line: 1, column: 6 }, signal())).toEqual({ places: [], outside: ["/elsewhere/lib.d.ts"], partial: false })
})
