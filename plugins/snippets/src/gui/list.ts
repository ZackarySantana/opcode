import type { Scope } from "../domain"
import type { SnippetEntry } from "../service"

/** Why `@name` would not insert a snippet as listed, or why it would not expand fully. */
export type Flag = "overridden" | "conflict" | "broken"

export interface SnippetGroup {
  scope: Scope
  rows: SnippetEntry[]
}

// Project snippets come first: they replace global ones with the same name.
const order: readonly Scope[] = ["project", "global"]

export function shorten(text: string, length: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}

export function flagOf(row: Pick<SnippetEntry, "overridden" | "conflict" | "problems">): Flag | undefined {
  if (row.conflict) return "conflict"
  if (row.overridden) return "overridden"
  if (row.problems.length) return "broken"
  return undefined
}

/** The line under a snippet's name: its description, else the start of its text. */
export function summary(row: Pick<SnippetEntry, "description" | "body">, length = 100): string {
  return shorten(row.description || row.body, length)
}

/**
 * Snippets whose name, aliases, description, or text contain every word of the query, ignoring case. A word starting
 * with `@` matches names and aliases only.
 */
export function filterSnippets(rows: readonly SnippetEntry[], query: string): SnippetEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...rows]
  return rows.filter((row) => {
    const keys = [row.name, ...row.aliases]
    const text = [...keys, row.description ?? "", row.body].join("\n").toLowerCase()
    return words.every((word) => word.startsWith("@")
      ? keys.some((key) => key.startsWith(word.slice(1)))
      : text.includes(word))
  })
}

/** Rows by scope, Project then Global, each by name; empty groups are left out. */
export function groupSnippets(rows: readonly SnippetEntry[]): SnippetGroup[] {
  return order
    .map((scope) => ({ scope, rows: rows.filter((row) => row.scope === scope).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) }))
    .filter((group) => group.rows.length)
}

/** The rows in display order, for moving the selection with the arrow keys. */
export function displayOrder(groups: readonly SnippetGroup[]): SnippetEntry[] {
  return groups.flatMap((group) => group.rows)
}

/** Identifies a row across reloads, which return new objects. */
export const rowKey = (row: Pick<SnippetEntry, "name" | "scope">) => `${row.scope}:${row.name}`

/** The row `offset` steps from the selected one, staying at the ends; the first row when none is selected. */
export function step(rows: readonly SnippetEntry[], selected: string | undefined, offset: number): SnippetEntry | undefined {
  const index = rows.findIndex((row) => rowKey(row) === selected)
  if (index < 0) return rows[0]
  return rows[Math.max(0, Math.min(rows.length - 1, index + offset))]
}

/** The text a pick types into the prompt, or why `@name` would insert something else. */
export function insertion(row: Pick<SnippetEntry, "name" | "overridden" | "conflict">): { text: string } | { blocked: "overridden" | "conflict" } {
  if (row.overridden) return { blocked: "overridden" }
  if (row.conflict) return { blocked: "conflict" }
  return { text: `@${row.name} ` }
}
