/** Usages of a symbol, arranged for review against the diff: where they sit, and which ones the change may have missed. Knows nothing about the host. */

import { parsePatch } from "./patch"
import type { Place } from "./references"
import { isDefinition } from "./symbols"

/** Where a reference sits relative to the diff: on a changed line, elsewhere in a changed file, or in a file the diff doesn't touch. */
export type Mark = "changed" | "diffed" | "outside"
export type Scope = "all" | "diff" | "outside"
export const scopes: readonly Scope[] = ["all", "diff", "outside"]

export interface Reference extends Place {
  readonly mark: Mark
  /** The line defines the symbol rather than using it. */
  readonly definition: boolean
  /** A use the change may have missed: its definition changed shape or was removed, and this line didn't change. */
  readonly notUpdated: boolean
}

export interface FileGroup {
  readonly file: string
  /** The diff changes this file. */
  readonly touched: boolean
  readonly references: readonly Reference[]
}

export interface ReferenceList {
  readonly name: string
  /** Definitions first, then files the diff changes (the current file first), then the rest; by line within a file. */
  readonly groups: readonly FileGroup[]
  /** The references the groups show, in the order shown. */
  readonly listed: readonly Reference[]
  readonly counts: { readonly total: number; readonly inDiff: number; readonly outside: number }
  /** The diff removes a definition of the name and adds one that reads differently, such as new parameters. */
  readonly signatureChanged: boolean
  /** The diff removes a definition of the name and adds none. */
  readonly removed: boolean
  /** The diff adds the definition, and nothing else uses the name. */
  readonly unused: boolean
}

/** The diff the references are measured against: each changed file and its unified patch. */
export interface DiffFile {
  readonly file: string
  readonly patch: string
}

/** Arranges found places for the list; `scope` filters the groups but never the counts or flags. */
export function arrangeReferences(name: string, places: readonly Place[], diff: readonly DiffFile[], options: { scope: Scope; current?: string; partial?: boolean }): ReferenceList {
  const added = new Map<string, Set<number>>()
  const removedDefinitions: string[] = []
  const addedDefinitions: string[] = []
  // Spacing alone doesn't change what a definition says.
  const shape = (text: string) => text.trim().replace(/\s+/g, " ")
  // When the places show where the name is defined, only definitions in those files count: elsewhere the same name
  // is likely something else, such as an object key. With no definition found (it may have been removed), all count.
  const defining = new Set(places.filter((place) => isDefinition(place.text, name, place.file)).map((place) => place.file))
  for (const { file, patch } of diff) {
    const lines = added.get(file) ?? new Set<number>()
    added.set(file, lines)
    const weighed = !defining.size || defining.has(file)
    for (const row of parsePatch(patch)) {
      if (row.kind === "add") lines.add(row.new!)
      if (weighed && row.kind !== "ctx" && isDefinition(row.text, name, file)) (row.kind === "add" ? addedDefinitions : removedDefinitions).push(shape(row.text))
    }
  }
  const signatureChanged = addedDefinitions.length > 0 && removedDefinitions.some((text) => !addedDefinitions.includes(text))
  const removed = removedDefinitions.length > 0 && !addedDefinitions.length

  const seen = new Set<string>()
  const references: Reference[] = []
  for (const place of places) {
    const key = `${place.file}:${place.line}:${place.column}`
    if (seen.has(key)) continue
    seen.add(key)
    const lines = added.get(place.file)
    const mark: Mark = !lines ? "outside" : lines.has(place.line) ? "changed" : "diffed"
    const definition = isDefinition(place.text, name, place.file)
    references.push({ ...place, mark, definition, notUpdated: (signatureChanged || removed) && !definition && mark !== "changed" })
  }

  const byFile = new Map<string, Reference[]>()
  for (const reference of references) byFile.set(reference.file, [...byFile.get(reference.file) ?? [], reference])
  const tier = (file: string) => byFile.get(file)!.some((reference) => reference.definition) ? 0 : added.has(file) ? 1 : 2
  const order = (file: string) => [tier(file), file === options.current ? 0 : 1] as const
  const files = [...byFile.keys()].sort((a, b) => {
    const [x, y] = [order(a), order(b)]
    return x[0] - y[0] || x[1] - y[1] || (a < b ? -1 : a > b ? 1 : 0)
  })
  const kept = (reference: Reference) => options.scope === "all" || (options.scope === "outside") === (reference.mark === "outside")
  const groups = files.flatMap((file): FileGroup[] => {
    const shown = byFile.get(file)!.filter(kept).sort((a, b) => a.line - b.line || a.column - b.column)
    return shown.length ? [{ file, touched: added.has(file), references: shown }] : []
  })
  const outside = references.filter((reference) => reference.mark === "outside").length
  return {
    name, groups, signatureChanged, removed, listed: groups.flatMap((group) => group.references),
    counts: { total: references.length, inDiff: references.length - outside, outside },
    // A language server still loading may not have found the uses yet.
    unused: !options.partial && addedDefinitions.length > 0 && references.every((reference) => reference.definition),
  }
}
