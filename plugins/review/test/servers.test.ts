import { expect, test } from "bun:test"
import { resolveServer, serversFor, validLspConfig } from "../src/servers"

const installed = (...names: string[]) => (command: string) => names.includes(command) ? `/usr/bin/${command}` : null

test("a file gets the built-in server for its extension when it's installed, with the executable's path", () => {
  expect(resolveServer("src/App.TSX", true, installed("typescript-language-server")))
    .toEqual({ name: "typescript", command: ["/usr/bin/typescript-language-server", "--stdio"] })
  expect(resolveServer("main.go", true, installed("typescript-language-server"))).toBeUndefined()
  expect(resolveServer("README.md", true, installed("typescript-language-server"))).toBeUndefined()
  expect(resolveServer("Makefile", true, installed("typescript-language-server"))).toBeUndefined()
})

test("config entries replace built-ins by name, disable them, or add servers", () => {
  const which = installed("typescript-language-server", "deno", "my-server")
  const lsp = {
    typescript: { disabled: true as const },
    deno: { command: ["deno", "lsp"], extensions: [".ts"], env: { DENO_DIR: "/tmp" }, initialization: { enable: true } },
  }
  expect(resolveServer("a.ts", lsp, which)).toEqual({ name: "deno", command: ["/usr/bin/deno", "lsp"], env: { DENO_DIR: "/tmp" }, initialization: { enable: true } })
  // Replacing only the command keeps the built-in's extensions.
  expect(resolveServer("a.ts", { typescript: { command: ["my-server"] } }, which)?.command).toEqual(["/usr/bin/my-server"])
  // An entry without extensions matches no file.
  expect(serversFor("a.lisp", { lisp: { command: ["my-server"] } })).toEqual([])
})

test("an uninstalled server gives way to the next one for the extension, and false turns them all off", () => {
  const lsp = { mine: { command: ["missing-server"], extensions: [".py"] } }
  expect(serversFor("a.py", lsp).map((server) => server.name)).toEqual(["pyright", "mine"])
  expect(resolveServer("a.py", { pyright: { disabled: true as const }, ...lsp, other: { command: ["my-server"], extensions: [".py"] } }, installed("my-server"))?.name).toBe("other")
  expect(resolveServer("a.ts", false, installed("typescript-language-server"))).toBeUndefined()
  expect(serversFor("a.ts", false)).toEqual([])
})

test("a client's lsp config keeps only well-formed entries, without variables that load code into child processes", () => {
  expect(validLspConfig(false)).toBe(false)
  expect(validLspConfig(undefined)).toBe(true)
  expect(validLspConfig("yes")).toBe(true)
  expect(validLspConfig({
    typescript: { disabled: true, command: "ignored" },
    spread: { command: "typescript-language-server --stdio", extensions: [".ts"] },
    empty: { command: [], extensions: [".ts"] },
    mixed: { command: ["deno", 1], extensions: [".ts"] },
    deno: {
      command: ["deno", "lsp"], extensions: ".ts", initialization: ["not", "an", "object"],
      env: { DENO_DIR: "/tmp", PORT: 8, LD_PRELOAD: "/evil.so", DYLD_INSERT_LIBRARIES: "/evil.dylib", NODE_OPTIONS: "--require /evil.js", bun_options: "-r x" },
    },
    other: "not an entry",
  })).toEqual({ typescript: { disabled: true }, deno: { command: ["deno", "lsp"], env: { DENO_DIR: "/tmp" } } })
  // An entry left without extensions matches no file of its own, and keeps a built-in's when it's named after one.
  expect(resolveServer("a.ts", validLspConfig({ deno: { command: ["deno", "lsp"], extensions: ".ts" } }), installed("deno"))).toBeUndefined()
  expect(serversFor("a.ts", { typescript: { command: ["deno"], extensions: "nope" } as never })).toEqual([])
})
