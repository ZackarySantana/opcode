/** Finds usages and definitions: by the file's language server when there is one that answers, else by searching for the name. */

import { errorMessage } from "@opcode/core"
import { basename, extname } from "node:path"
import type { Kind, Pool } from "./lsp"
import type { Found, Lookup, LspConfig } from "./references"
import type { Searched } from "./search"
import { resolveServer, serverLabel, serversFor, type Server, type Which } from "./servers"
import { isDefinition as definesName } from "./symbols"

export type Search = (directory: string, name: string, signal: AbortSignal) => Promise<Searched>

export interface FinderOptions {
  readonly pool: Pick<Pool, "locate">
  readonly search: Search
  readonly resolve?: (file: string, lsp: LspConfig, which: Which) => Server | undefined
  readonly isDefinition?: (text: string, name: string, file: string) => boolean
  /** The most places a language server's answer keeps. */
  readonly limit?: number
}

/** `lsp` is the merged `lsp` config, or null to search by name only. */
export type FindIn = (directory: string, lookup: Lookup, lsp: LspConfig | null, signal: AbortSignal) => Promise<Found>

export interface Finder {
  /** Where the symbol is used, its definition included. */
  readonly usages: FindIn
  /** Where the symbol is defined. */
  readonly definition: FindIn
}

export function createFinder({ pool, search, resolve = resolveServer, isDefinition = definesName, limit = 1000 }: FinderOptions): Finder {
  /** Why no language server can answer for the file. */
  const unavailable = (file: string, lsp: LspConfig) => {
    if (lsp === false) return "language servers are off"
    const configured = serversFor(file, lsp)[0]
    if (configured) return `${serverLabel(configured)} is not installed`
    const extension = extname(file)
    return extension ? `no language server for ${extension}` : "no language server for this file"
  }

  const bySearch = async (kind: Kind, directory: string, lookup: Lookup, signal: AbortSignal, fallback?: string): Promise<Found> => {
    const found = await search(directory, lookup.name, signal)
    // A definition found by name is a line that defines it, by the file's language; none is an honest answer.
    const places = kind === "definition" ? found.places.filter((place) => isDefinition(place.text, lookup.name, place.file)) : found.places
    return { engine: "search", places, truncated: found.truncated, ...fallback ? { fallback } : {} }
  }

  const find = (kind: Kind): FindIn => async (directory, lookup, lsp, signal) => {
    if (lsp === null) return await bySearch(kind, directory, lookup, signal)
    const server = resolve(lookup.file, lsp, (command) => Bun.which(command, { cwd: directory }))
    if (!server) return await bySearch(kind, directory, lookup, signal, unavailable(lookup.file, lsp))
    const label = serverLabel(server)
    let reason: string
    try {
      const { places, outside, partial } = await pool.locate(directory, server, kind, lookup, signal)
      const found = { engine: "lsp", server: label, ...partial ? { partial } : {} } as const
      if (places.length) return { ...found, places: places.slice(0, limit), truncated: places.length > limit }
      // Such as a standard library's declarations: the server's answer, which a search of the project can't improve on.
      if (outside.length) return { ...found, places: [], truncated: false, fallback: `${kind === "definition" ? "defined" : "only found"} outside the project (…/${basename(outside[0]!)})` }
      reason = partial ? `${label} is still loading the project` : `${label} returned no results`
    } catch (error) {
      // The caller gave up, so nobody waits on a search either.
      if (signal.aborted) throw signal.reason
      reason = errorMessage(error)
    }
    return await bySearch(kind, directory, lookup, signal, reason)
  }

  return { usages: find("usages"), definition: find("definition") }
}
