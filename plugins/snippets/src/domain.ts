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
type Expandable = Keyed & Pick<Snippet, "body">

/**
 * `@name` standing on its own between spaces, so file paths, scoped packages, and emails never match. It marks a
 * snippet in a prompt and a reference to another snippet in a body.
 */
export const MENTION = /(?<!\S)@([a-z0-9-]+)(?!\S)/g

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
  const keys = effectiveSnippets<T | Keyed>([...beside(snippets, snippet), snippet])
  return snippet.aliases.flatMap((alias) => {
    const owner = keys.get(alias)
    return owner && owner !== snippet ? [[alias, owner as T] as [string, T]] : []
  })
}

/** The snippets `snippet` is written among: its namesake is replaced, and a global one sees global snippets only. */
function beside<T extends Keyed>(snippets: readonly T[], snippet: Keyed): T[] {
  return snippets.filter((other) => (other.scope !== snippet.scope || other.name !== snippet.name) && (snippet.scope === "project" || other.scope === "global"))
}

/** A snippet's text with every reference replaced by the referenced snippet's current text, and what didn't resolve. */
export interface Expansion {
  text: string
  /** Referenced names that are no snippet, left as typed. */
  missing: string[]
  /** Reference paths from this snippet that lead back to a snippet already being expanded, whose last one is left as typed. */
  cycles: string[][]
  /** The expanded text was over MAX_BODY bytes, so `text` is the body with its references left as typed. */
  tooLarge: boolean
}

/** Every name and alias a reference can use: what a user can type, less names other skills own. */
export function referenceKeys<T extends Keyed>(snippets: readonly T[], blocked: ReadonlySet<string> = new Set()): Map<string, T> {
  return new Map([...effectiveSnippets(snippets)].filter(([key]) => !blocked.has(key)))
}

/** Text split into plain runs and `@name` references to snippets, so a view can color the references. */
export function referenceSegments(text: string, isSnippet: (key: string) => boolean): { text: string; reference: boolean }[] {
  const segments: { text: string; reference: boolean }[] = []
  let last = 0
  for (const match of text.matchAll(MENTION)) {
    if (!isSnippet(match[1]!)) continue
    if (match.index > last) segments.push({ text: text.slice(last, match.index), reference: false })
    segments.push({ text: match[0], reference: true })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last), reference: false })
  return segments
}

/** Expands `@name` references in place, through nested references, stopping at loops and at MAX_BODY bytes. */
export function expandSnippet<T extends Pick<Snippet, "body">>(snippet: T, keys: ReadonlyMap<string, T>): Expansion {
  const missing = new Set<string>()
  const cycles = new Map<string, string[]>()
  const tooLarge = Symbol("too large")
  const expand = (current: T, chain: readonly T[], path: readonly string[]): string => {
    let text = ""
    let last = 0
    for (const match of current.body.matchAll(MENTION)) {
      const key = match[1]!
      const target = keys.get(key)
      text += current.body.slice(last, match.index)
      last = match.index + match[0].length
      if (!target) { missing.add(key); text += match[0] }
      else if (chain.includes(target)) { cycles.set([...path, key].join(" "), [...path, key]); text += match[0] }
      else text += expand(target, [...chain, target], [...path, key])
      // Checked as it grows, so references repeated at every level stop early. A string is never more characters than bytes.
      if (text.length > MAX_BODY) throw tooLarge
    }
    return text + current.body.slice(last)
  }
  try {
    const text = expand(snippet, [snippet], [])
    if (Buffer.byteLength(text) > MAX_BODY) throw tooLarge
    return { text, missing: [...missing], cycles: [...cycles.values()], tooLarge: false }
  } catch (error) {
    if (error !== tooLarge) throw error
    return { text: snippet.body, missing: [...missing], cycles: [...cycles.values()], tooLarge: true }
  }
}

/** Why some of a snippet's references don't expand, for a user or model to act on. */
export function referenceProblems(expansion: Expansion): string[] {
  return [
    ...expansion.missing.map((key) => `@${key} is not a snippet.`),
    ...expansion.cycles.map((path) => `${path.map((key) => `@${key}`).join(" → ")} loops back to a snippet already being expanded.`),
    ...expansion.tooLarge ? [`With its references it is over ${MAX_BODY} bytes, so they stay as typed.`] : [],
  ]
}

/** How `snippet` would expand once written; `blocked` are names other skills own. */
export function expandWrite<T extends Expandable>(snippets: readonly T[], snippet: Expandable, blocked?: ReadonlySet<string>): Expansion {
  return expandSnippet<T | Expandable>(snippet, referenceKeys<T | Expandable>([...beside(snippets, snippet), snippet], blocked))
}

/** Snippets in `after` with a reference that resolved in `before` and no longer does, such as after a delete or rename. */
export function newlyBroken<T extends Expandable>(before: readonly T[], after: readonly T[], blocked?: ReadonlySet<string>): T[] {
  const was = referenceKeys(before, blocked)
  const now = referenceKeys(after, blocked)
  return [...new Set(now.values())].filter((snippet) => {
    const missing = new Set(expandSnippet(snippet, was).missing)
    return expandSnippet(snippet, now).missing.some((key) => !missing.has(key))
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

export const WRITE_ACTION = "snippet_write"
export const DELETE_ACTION = "snippet_delete"

type Rule = { action: string; resource: string; effect: string }

/**
 * Makes an agent ask before snippet writes and deletes, which the base policy would allow silently. The rules go first
 * among the agent's own, so a rule configured for that agent, or one the user saved with "Allow always", still wins.
 */
export function askFirst(permissions: Rule[]): void {
  for (const action of [DELETE_ACTION, WRITE_ACTION]) {
    if (!permissions.some((rule) => rule.action === action)) permissions.unshift({ action, resource: "*", effect: "ask" })
  }
}

/** Starts a request in the current session that the agent answers with its snippet tools. */
export const SAVE_LEAD = "Save as a snippet: "

/** `/snippets new` opens the editor, `/snippets save [what]` asks the agent; anything else opens the list. */
export function parseCommand(input = ""): { verb: "new" } | { verb: "save"; request: string } | { verb: "open" } {
  const [, verb, request = ""] = /^\s*(?:\/\S+)?\s*(\S*)\s*([\s\S]*)$/.exec(input) ?? []
  if (verb === "new") return { verb }
  if (verb === "save") return { verb, request: request.trim() }
  return { verb: "open" }
}
