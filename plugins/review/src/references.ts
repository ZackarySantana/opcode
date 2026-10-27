/** What finding usages and definitions passes between the terminal and the server. Knows nothing about the host. */

/** A place in a file of the session's directory. */
export interface Place {
  /** Relative to the session's directory, with forward slashes. */
  readonly file: string
  /** 1-based. */
  readonly line: number
  /** 0-based, in UTF-16 code units, where the symbol starts. */
  readonly column: number
  /** The whole line, without its line break. */
  readonly text: string
}

/** The symbol under the cursor: its name and where it is. */
export interface Lookup extends Omit<Place, "text"> {
  readonly name: string
}

/** One language server, as OpenCode's `lsp` config describes it. */
export interface LanguageServer {
  readonly command: readonly string[]
  readonly extensions?: readonly string[]
  readonly disabled?: boolean
  readonly env?: Readonly<Record<string, string>>
  readonly initialization?: Readonly<Record<string, unknown>>
}

/** OpenCode's merged `lsp` config: false turns language servers off, true or absent keeps the defaults. */
export type LspConfig = boolean | Readonly<Record<string, { readonly disabled: true } | LanguageServer>>

export type Engine = "lsp" | "search"

export interface Found {
  /** What answered: a language server, or a text search for the name. */
  readonly engine: Engine
  /** The language server's name, when one answered. */
  readonly server?: string
  readonly places: readonly Place[]
  /** More matched than were returned. */
  readonly truncated: boolean
  /** Why the answer is not the language server's plain one: why a search answered instead, or that it found the name only outside the project. */
  readonly fallback?: string
  /** The language server answered while still loading the project, so it may have missed some places. */
  readonly partial?: boolean
}

/** Merges the `lsp` sections of OpenCode's config documents, later documents winning per server, as OpenCode does. */
export function mergeLspConfig(documents: readonly { readonly lsp?: LspConfig }[]): LspConfig | undefined {
  let merged: LspConfig | undefined
  for (const { lsp } of documents) {
    if (lsp === undefined) continue
    if (typeof lsp === "boolean" || typeof merged !== "object") merged = lsp
    else merged = { ...merged, ...lsp }
  }
  return merged
}
