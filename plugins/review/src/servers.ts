/** Which language server answers for a file: OpenCode's `lsp` config over a table of common servers. Knows nothing about the host. */

import { basename, extname } from "node:path"
import type { LanguageServer, LspConfig } from "./references"

/** A language server to start, with its executable found. */
export interface Server {
  /** Its name in the `lsp` config. */
  readonly name: string
  readonly command: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly initialization?: Readonly<Record<string, unknown>>
}

/** Finds an executable by name or path, as `Bun.which` does. */
export type Which = (command: string) => string | null

// Named as OpenCode names its built-in servers, so a config entry that disables or replaces one applies here too.
const builtins: Readonly<Record<string, LanguageServer>> = {
  typescript: { command: ["typescript-language-server", "--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] },
  gopls: { command: ["gopls"], extensions: [".go"] },
  rust: { command: ["rust-analyzer"], extensions: [".rs"] },
  pyright: { command: ["pyright-langserver", "--stdio"], extensions: [".py", ".pyi"] },
  clangd: { command: ["clangd"], extensions: [".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++"] },
  "ruby-lsp": { command: ["ruby-lsp"], extensions: [".rb", ".rake", ".gemspec", ".ru"] },
  zls: { command: ["zls"], extensions: [".zig", ".zon"] },
  "lua-ls": { command: ["lua-language-server"], extensions: [".lua"] },
  bash: { command: ["bash-language-server", "start"], extensions: [".sh", ".bash", ".zsh"] },
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string")
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/**
 * Variables that load code into every process the server starts, its helpers included (tsserver, go list, cargo). They're
 * never needed to configure a language server, and one meant for a single server would leak into all of its children.
 */
const loaders = /^(LD_.*|DYLD_.*|NODE_OPTIONS|BUN_OPTIONS|PYTHONSTARTUP|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)$/i

/** The `lsp` config as a client sent it, keeping only well-formed entries: a malformed one is ignored, as if it weren't there. */
export function validLspConfig(value: unknown): LspConfig {
  if (typeof value === "boolean") return value
  if (!isRecord(value)) return true
  const entries = Object.entries(value).flatMap(([name, entry]): [string, LanguageServer | { disabled: true }][] => {
    if (!isRecord(entry)) return []
    if (entry.disabled === true) return [[name, { disabled: true }]]
    const { command, extensions, env, initialization } = entry
    if (!strings(command) || !command.length || !command[0]) return []
    return [[name, {
      command,
      ...strings(extensions) ? { extensions } : {},
      ...isRecord(env) ? { env: Object.fromEntries(Object.entries(env).filter(([key, value]) => typeof value === "string" && !loaders.test(key))) as Record<string, string> } : {},
      ...isRecord(initialization) ? { initialization } : {},
    }]]
  })
  return Object.fromEntries(entries)
}

/** A server's short name for messages: its executable's. */
export const serverLabel = (server: Pick<Server, "command">) => basename(server.command[0] ?? "language server")

/** The servers configured for the file's extension, in order, whether or not they're installed. */
export function serversFor(file: string, lsp: LspConfig): Server[] {
  if (lsp === false) return []
  const extension = extname(file).toLowerCase()
  if (!extension) return []
  const merged: Record<string, LanguageServer | { disabled: true }> = { ...builtins }
  // An entry for a built-in replaces what it names and keeps the rest, such as its extensions.
  if (typeof lsp === "object") for (const [name, entry] of Object.entries(lsp)) merged[name] = { ...builtins[name], ...entry }
  return Object.entries(merged).flatMap(([name, entry]): Server[] =>
    !entry.disabled && "command" in entry && Array.isArray(entry.command) && entry.command.length && Array.isArray(entry.extensions) && entry.extensions.some((candidate) => typeof candidate === "string" && candidate.toLowerCase() === extension)
      ? [{ name, command: entry.command, env: entry.env, initialization: entry.initialization }]
      : [])
}

/** The first configured server for the file whose executable is found, with its path filled in. */
export function resolveServer(file: string, lsp: LspConfig, which: Which = (command) => Bun.which(command)): Server | undefined {
  for (const server of serversFor(file, lsp)) {
    const [executable, ...args] = server.command
    const found = executable && which(executable)
    if (found) return { ...server, command: [found, ...args] }
  }
}
