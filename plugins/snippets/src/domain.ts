export const PLUGIN_ID = "opcode-snippets"
export type Scope = "global" | "project"
export const scopes: readonly Scope[] = ["global", "project"]

/** Lowercase kebab-case with at least one letter. */
const NAME = /^(?=[a-z0-9-]*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_NAME = 64
export const MAX_BODY = 65_536

export function validName(name: unknown): name is string {
  return typeof name === "string" && name.length <= MAX_NAME && NAME.test(name)
}

export interface SnippetFields {
  description?: string
  aliases: string[]
  body: string
}

export interface Snippet extends SnippetFields {
  name: string
  scope: Scope
  path: string
}

const FRONTMATTER = /^---[\t ]*\r?\n(?:([\s\S]*?)\r?\n)??---[\t ]*(?:\r?\n|$)/

function unquote(value: string): string {
  if (value.startsWith("\"")) { try { return String(JSON.parse(value)) } catch { /* Keep the raw text. */ } }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  return value
}

/** Reads `description` and `aliases` (inline list, comma list, or `- item` lines); other keys are ignored. */
export function parseSnippet(text: string): SnippetFields {
  // Some editors save a byte order mark, which would hide the frontmatter.
  if (text.startsWith("\uFEFF")) text = text.slice(1)
  const match = FRONTMATTER.exec(text)
  if (!match) return { aliases: [], body: text.trim() }
  let description: string | undefined
  const aliases: string[] = []
  let key: string | undefined
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const item = /^\s*-\s*(.*)$/.exec(line)
    if (item) { if (key === "aliases") aliases.push(unquote(item[1]!.trim())); continue }
    const field = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!field) continue
    key = field[1]
    const value = field[2]!.trim()
    if (key === "description" && value) description = unquote(value)
    if (key === "aliases" && value) aliases.push(...value.replace(/^\[(.*)\]$/, "$1").split(",").map((alias) => unquote(alias.trim())).filter(Boolean))
  }
  return { ...(description ? { description } : {}), aliases: aliases.filter(validName), body: text.slice(match[0].length).trim() }
}

export function formatSnippet(fields: SnippetFields): string {
  const lines = [
    ...(fields.description ? [`description: ${JSON.stringify(fields.description)}`] : []),
    ...(fields.aliases.length ? [`aliases: [${fields.aliases.join(", ")}]`] : []),
  ]
  const body = `${fields.body.trim()}\n`
  // A body that itself starts like frontmatter needs a block before it to be read back unchanged.
  if (!lines.length && !FRONTMATTER.test(body)) return body
  return `---\n${lines.map((line) => `${line}\n`).join("")}---\n\n${body}`
}

/** Normalized fields for a write, or an error a user or model can act on. */
export function validateSnippet(name: string, fields: SnippetFields): SnippetFields {
  if (!validName(name)) throw new Error(`Invalid snippet name "${name}". Use lowercase letters, digits, and single hyphens, with at least one letter.`)
  const body = fields.body.trim()
  if (!body) throw new Error("A snippet needs body text.")
  if (Buffer.byteLength(body) > MAX_BODY) throw new Error(`Snippet bodies are limited to ${MAX_BODY} bytes.`)
  const aliases = [...new Set(fields.aliases)]
  const invalid = aliases.find((alias) => !validName(alias) || alias === name)
  if (invalid !== undefined) throw new Error(`Invalid alias "${invalid}".`)
  // Frontmatter values are single lines.
  return { description: fields.description?.replace(/\s+/g, " ").trim() || undefined, aliases, body }
}

type Keyed = Pick<Snippet, "name" | "scope" | "aliases">

/**
 * Every name and alias a user can type, mapped to its snippet. Project names override global ones, names beat aliases,
 * and an alias claimed twice goes to the project snippet, then to the first by name.
 */
export function effectiveSnippets<T extends Keyed>(snippets: readonly T[]): Map<string, T> {
  const rank = (snippet: T) => snippet.scope === "project" ? 0 : 1
  const ordered = [...snippets].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const keys = new Map<string, T>()
  for (const snippet of ordered) if (!keys.has(snippet.name)) keys.set(snippet.name, snippet)
  for (const snippet of ordered) {
    if (keys.get(snippet.name) !== snippet) continue
    for (const alias of snippet.aliases) if (!keys.has(alias)) keys.set(alias, snippet)
  }
  return keys
}

/**
 * Aliases of `snippet` that would insert another snippet once it replaces its namesake, each with that other snippet.
 * A global snippet is checked against global ones only: a project's own snippets may override it there.
 */
export function takenAliases<T extends Keyed>(snippets: readonly T[], snippet: Keyed): [alias: string, owner: T][] {
  const others = snippets.filter((other) => (other.scope !== snippet.scope || other.name !== snippet.name) && (snippet.scope === "project" || other.scope === "global"))
  const keys = effectiveSnippets<T | Keyed>([...others, snippet])
  return snippet.aliases.flatMap((alias) => {
    const owner = keys.get(alias)
    return owner && owner !== snippet ? [[alias, owner as T] as [string, T]] : []
  })
}

/** The skill name that marks a registration as ours; anything else at the same ID is a collision. */
export function skillName(key: string): string {
  return `${key} · snippet`
}

export function skillDescription(key: string, snippet: Snippet): string {
  if (key !== snippet.name) return `Snippet · alias of @${snippet.name}`
  const summary = snippet.description || snippet.body.split("\n").find((line) => line.trim())?.trim() || "empty"
  return `Snippet · ${summary.length > 80 ? `${summary.slice(0, 79)}…` : summary}`
}

/** Session metadata key marking an authoring session, and its optional target snippet. */
export const AUTHORING = PLUGIN_ID
export type Authoring = { name?: string; scope?: Scope }
export const WRITE_ACTION = "snippet_write"
export const DELETE_ACTION = "snippet_delete"
const authoringRules = [WRITE_ACTION, DELETE_ACTION].map((action) => ({ action, resource: "*", effect: "ask" as const }))

type Rule = { action: string; resource: string; effect: string }

/** An authoring session carries its marker and still has the rules that make writes and deletes ask. */
export function authoringOf(session: { metadata?: unknown; permissions?: readonly Rule[] }): Authoring | undefined {
  const value = session.metadata && typeof session.metadata === "object" ? (session.metadata as Record<string, unknown>)[AUTHORING] : undefined
  if (!value || typeof value !== "object") return undefined
  const rules = session.permissions ?? []
  if (!authoringRules.every((rule) => rules.some((other) => other.action === rule.action && other.resource === rule.resource && other.effect === rule.effect))) return undefined
  const { name, scope } = value as Record<string, unknown>
  return { ...(validName(name) ? { name } : {}), ...(scope === "global" || scope === "project" ? { scope } : {}) }
}

/** Session fields for a new authoring session: its marker, and rules so every write and delete asks first. */
export function authoringSession(target: Authoring) {
  return { title: target.name ? `Snippet @${target.name}` : "New snippet", metadata: { [AUTHORING]: target }, permissions: authoringRules }
}

/** How snippets work, opening an authoring session; the user's request follows it after a few blank lines. */
export function authoringGuide(target: Authoring): string {
  return [
    "You are helping the user make a snippet: reusable prompt text they insert into a message with @name. This is how it works:",
    "- Use snippet_list, snippet_write, and snippet_delete. Never edit snippet files directly.",
    "- Names are lowercase kebab-case. Global snippets apply everywhere; project snippets apply to this project and override a global snippet with the same name.",
    "- A snippet is only the text to insert. Snippets have no templating, arguments, shell substitution, or includes.",
    "- Before writing any snippet, walk the user through a human-digestible example: the name and scope you propose, the exact text, and a sample message that uses it (such as \"@name fix the login bug\") with what the agent would take from it. Write it only once the user agrees; they also approve each write and delete.",
    ...target.name ? [`- This session is about the existing snippet @${target.name}${target.scope ? ` (${target.scope})` : ""}. Read it with snippet_list first. If the user's message doesn't say what to change, ask them.`] : [],
  ].join("\n") + "\n\n\n\n"
}

/** Leads the user's own message when the guide waits in the prompt for them to finish. */
export const AUTHORING_LEAD = "The following message is what the user wants: "

export const authoringRequest = (target: Authoring, request: string) => `${authoringGuide(target)}The user wants to create a snippet that ${request}`
