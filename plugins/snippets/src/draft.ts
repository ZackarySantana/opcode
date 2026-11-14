import type { SessionMessageInfo } from "@opencode/client"
import type { Scope, SnippetFields } from "./domain"
import type { SnippetEntry, SnippetKey } from "./service"

/** The editor's fields as typed: aliases stay one line of text until saved. */
export interface Draft {
  name: string
  scope: Scope
  description: string
  aliases: string
  body: string
}

export const emptyDraft = (body = ""): Draft => ({ name: "", scope: "global", description: "", aliases: "", body })

export const draftOf = (row: SnippetEntry): Draft =>
  ({ name: row.name, scope: row.scope, description: row.description ?? "", aliases: row.aliases.join(" "), body: row.body })

/**
 * A copy beside the original under the first free `<name>-copy`, `<name>-copy-2`, …. Its aliases would only clash with
 * the original's, so it has none.
 */
export function duplicateOf(row: SnippetEntry, rows: readonly Pick<SnippetEntry, "name" | "aliases">[]): Draft {
  const taken = new Set(rows.flatMap((other) => [other.name, ...other.aliases]))
  const base = `${row.name}-copy`
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
  return { ...draftOf(row), name, aliases: "" }
}

/** Aliases separated by spaces or commas; a leading `@` is what the user types in a prompt, so it is dropped. */
export const parseAliases = (text: string): string[] => text.split(/[\s,]+/).map((alias) => alias.replace(/^@/, "")).filter(Boolean)

export function saveRequest(draft: Draft, from?: SnippetKey): SnippetKey & { fields: SnippetFields; from?: SnippetKey } {
  const description = draft.description.trim()
  return {
    name: draft.name.trim(),
    scope: draft.scope,
    fields: { ...(description ? { description } : {}), aliases: parseAliases(draft.aliases), body: draft.body },
    ...(from ? { from } : {}),
  }
}

export const sameDraft = (a: Draft, b: Draft) =>
  a.name === b.name && a.scope === b.scope && a.description === b.description && a.aliases === b.aliases && a.body === b.body

export interface MessageChoice {
  role: "user" | "assistant"
  text: string
  created: number
}

/** The text of a session's user and assistant messages, newest first. Reasoning and tool calls are left out. */
export function messageChoices(messages: readonly SessionMessageInfo[]): MessageChoice[] {
  return messages.flatMap((message): MessageChoice[] => {
    const text = message.type === "user" ? message.text
      : message.type === "assistant" ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n")
      : ""
    return text.trim() ? [{ role: message.type as "user" | "assistant", text: text.trim(), created: message.time.created }] : []
  }).sort((a, b) => b.created - a.created)
}
