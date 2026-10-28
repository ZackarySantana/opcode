import type { Scope } from "../domain"
import type { SnippetEntry } from "../service"

export type Translate = (key: string, params?: Record<string, string | number | boolean>) => string

/** What a pick in the snippet list stands for: writing a new snippet, or one snippet. */
export type Choice = { type: "new" } | { type: "snippet"; snippet: SnippetEntry }

export interface Option {
  title: string
  value: Choice
  description?: string
  group?: string
}

// Project snippets come first: they replace global ones with the same name.
const order: readonly Scope[] = ["project", "global"]
const PREVIEW = 100

function shorten(text: string, length: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}

/**
 * Snippets by scope for a searchable select, which matches titles and descriptions: the description carries the
 * summary, the aliases, and why `@name` would not insert the snippet.
 */
export function snippetOptions(rows: readonly SnippetEntry[], t: Translate, options: { create?: boolean } = {}): Option[] {
  const create: Option[] = options.create ? [{ title: t("select.new"), description: t("select.new.description"), value: { type: "new" } }] : []
  return [...create, ...order.flatMap((scope) => rows.filter((row) => row.scope === scope).map((row): Option => {
    const flag = row.conflict ? t("flag.conflict") : row.overridden ? t("flag.overridden") : undefined
    const description = [
      shorten(row.description ?? row.body, PREVIEW),
      row.aliases.map((alias) => `@${alias}`).join(" "),
      flag,
    ].filter(Boolean).join(" · ")
    return { title: `@${row.name}`, description, group: t(`group.${scope}`), value: { type: "snippet", snippet: row } }
  }))]
}

/** The text a pick types into the prompt, or why `@name` would insert something else. */
export function insertion(row: Pick<SnippetEntry, "name" | "overridden" | "conflict">): { text: string } | { blocked: "overridden" | "conflict" } {
  if (row.overridden) return { blocked: "overridden" }
  if (row.conflict) return { blocked: "conflict" }
  return { text: `@${row.name} ` }
}
