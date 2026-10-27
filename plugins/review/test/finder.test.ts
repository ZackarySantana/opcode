import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { createFinder, type Search } from "../src/finder"
import server from "../src/index"
import type { Pool } from "../src/lsp"
import type { Lookup, Place } from "../src/references"
import type { Server } from "../src/servers"

const lookup: Lookup = { file: "src/a.ts", line: 3, column: 6, name: "load" }
const place = (file: string, line: number, text: string): Place => ({ file, line, column: text.indexOf("load"), text })
const found = [place("src/a.ts", 3, "const load = () => 1"), place("src/b.ts", 7, "load()")]
const fakeServer: Server = { name: "typescript", command: ["/usr/bin/typescript-language-server", "--stdio"] }

/** A finder over a fake pool and search, recording what each was asked. */
function finder(locate: Pool["locate"] = async () => ({ places: [place("src/b.ts", 7, "load()")], outside: [], partial: false }), resolve = (_file: string) => fakeServer as Server | undefined) {
  const asked = { pool: 0, search: 0 }
  const search: Search = async () => { asked.search++; return { places: found, truncated: true } }
  const subject = createFinder({
    pool: { locate: async (...args) => { asked.pool++; return await locate(...args) } },
    search,
    resolve,
    isDefinition: (text, name) => text.startsWith(`const ${name} `),
  })
  return { ...subject, asked }
}

const signal = () => new AbortController().signal

test("a language server's answer is used when it has one", async () => {
  const { usages, definition, asked } = finder()
  expect(await usages("/w", lookup, true, signal())).toEqual({ engine: "lsp", server: "typescript-language-server", places: [place("src/b.ts", 7, "load()")], truncated: false })
  expect(await definition("/w", lookup, {}, signal())).toMatchObject({ engine: "lsp" })
  expect(asked).toEqual({ pool: 2, search: 0 })
})

test("search only skips language servers, and finds a definition as a line that defines the name", async () => {
  const { usages, definition, asked } = finder()
  expect(await usages("/w", lookup, null, signal())).toEqual({ engine: "search", places: found, truncated: true })
  expect(await definition("/w", lookup, null, signal())).toEqual({ engine: "search", places: [found[0]!], truncated: true })
  expect(asked.pool).toBe(0)
  // No defining line means no definition, rather than every mention.
  expect((await definition("/w", { ...lookup, name: "missing" }, null, signal())).places).toEqual([])
})

test("search answers with the reason when a language server fails, times out, or finds nothing", async () => {
  expect(await finder(async () => ({ places: [], outside: [], partial: false })).usages("/w", lookup, true, signal())).toEqual({ engine: "search", places: found, truncated: true, fallback: "typescript-language-server returned no results" })
  expect((await finder(async () => { throw new Error("typescript-language-server timed out") }).definition("/w", lookup, true, signal())))
    .toEqual({ engine: "search", places: [found[0]!], truncated: true, fallback: "typescript-language-server timed out" })
})

test("an answer from a server still loading the project is marked partial, and none from it falls back to search", async () => {
  expect(await finder(async () => ({ places: [found[1]!], outside: [], partial: true })).usages("/w", lookup, true, signal())).toMatchObject({ engine: "lsp", places: [found[1]!], partial: true })
  expect(await finder(async () => ({ places: [], outside: [], partial: true })).usages("/w", lookup, true, signal()))
    .toMatchObject({ engine: "search", fallback: "typescript-language-server is still loading the project" })
})

test("a definition only outside the directory is the language server's answer, without a search", async () => {
  const outside = finder(async () => ({ places: [], outside: ["/usr/lib/node_modules/typescript/lib/lib.dom.d.ts"], partial: false }))
  expect(await outside.definition("/w", lookup, true, signal()))
    .toEqual({ engine: "lsp", server: "typescript-language-server", places: [], truncated: false, fallback: "defined outside the project (…/lib.dom.d.ts)" })
  expect(outside.asked.search).toBe(0)
  // Places inside the directory are answer enough; those outside are simply left out.
  expect(await finder(async () => ({ places: [found[1]!], outside: ["/lib.d.ts"], partial: false })).usages("/w", lookup, true, signal())).toEqual({ engine: "lsp", server: "typescript-language-server", places: [found[1]!], truncated: false })
})

test("search answers with why no language server could, when none is configured, installed, or allowed", async () => {
  const none = finder(undefined, () => undefined)
  expect((await none.usages("/w", { ...lookup, file: "README.md" }, true, signal())).fallback).toBe("no language server for .md")
  expect((await none.usages("/w", { ...lookup, file: "main.go" }, true, signal())).fallback).toBe("gopls is not installed")
  expect((await none.usages("/w", { ...lookup, file: "main.go" }, { gopls: { disabled: true } }, signal())).fallback).toBe("no language server for .go")
  expect((await none.usages("/w", lookup, false, signal())).fallback).toBe("language servers are off")
  expect(none.asked.pool).toBe(0)
})

test("a caller that gave up gets its abort, not a search", async () => {
  const controller = new AbortController()
  const subject = finder(async () => { controller.abort(new Error("moved on")); throw new Error("cancelled") })
  await expect(subject.usages("/w", lookup, true, controller.signal)).rejects.toThrow("moved on")
  expect(subject.asked.search).toBe(0)
})

const root = mkdtempSync(join(tmpdir(), "review-finder-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("the server plugin answers usages in its location's directory, and reports failures as the declared error", async () => {
  writeFileSync(join(root, "a.py"), "def load():\n  return load\n")
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited
  const location = { directory: root }
  let handlers: Record<string, (input: unknown, call: unknown) => Promise<unknown>> = {}
  const ctx = {
    location,
    storage: { get: async () => undefined, set: async () => {} },
    tool: { transform: async () => {} },
    session: { hook: async () => {} },
    rpc: { register: async (_definition: unknown, registered: typeof handlers) => { handlers = registered; return { dispose: async () => {} } } },
  } as unknown as Plugin.Context
  const cleanup = await server.setup(ctx)
  const call = (controller = new AbortController()) => ({ signal: controller.signal, error: (type: string, message: string) => ({ type, message }) })
  const query = { lookup: { file: "a.py", line: 1, column: 4, name: "load" }, lsp: null }
  expect(await handlers.usages!(query, call())).toMatchObject({ engine: "search", places: [{ file: "a.py", line: 1 }, { file: "a.py", line: 2 }] })
  // A malformed config from the client is ignored rather than spread into a command.
  const malformed = { ...query, lsp: { pyright: { disabled: true }, broken: { command: "pyright-langserver --stdio", extensions: [".py"] } } }
  expect(await handlers.usages!(malformed, call())).toMatchObject({ engine: "search", fallback: "no language server for .py" })
  location.directory = join(root, "missing")
  await expect(handlers.usages!(query, call())).rejects.toMatchObject({ type: "failed" })
  await cleanup?.()
})
