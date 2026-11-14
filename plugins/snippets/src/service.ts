import { createSerialQueue } from "@opcode/core"
import { Skill } from "@opencode/plugin"
import type { SkillEditor } from "@opencode/plugin/promise/skill"
import {
  effectiveSnippets, expandSnippet, expandWrite, newlyBroken, referenceProblems, skillDescription, skillName, takenAliases, validateSnippet,
  type Scope, type Snippet, type SnippetFields,
} from "./domain"
import type { SnippetStore } from "./store"

export interface SnippetEntry extends Snippet {
  /** A project snippet with the same name replaces this global one. */
  overridden: boolean
  /** Another skill owns this name, so `@name` does not insert the snippet. */
  conflict: boolean
  /** The text `@name` attaches, with its references expanded. */
  expanded: string
  /** Why some of its `@name` references stay as typed. */
  problems: string[]
  /** Snippets whose references would stop resolving if this one were deleted. */
  breaks: string[]
}

export interface SkillHost {
  reload(): Promise<void>
  list(): Promise<{ data: readonly { id: string; name: string; path: string }[] }>
}

export type SnippetKey = { name: string; scope: Scope }

export interface SaveRequest extends SnippetKey {
  fields: SnippetFields
  /** The snippet this one replaces: renamed or moved when it differs from `name` and `scope`. */
  from?: SnippetKey
  /** Whether another snippet already at `name` and `scope` may be replaced. */
  replace?: boolean
}

/** A checked save, ready to commit: its normalized fields, the text it expands to, and the snippets it would break. */
export interface PreparedSave extends SnippetKey {
  fields: SnippetFields
  from?: SnippetKey
  expanded: string
  breaks: string[]
}

const same = (a: SnippetKey, b: SnippetKey) => a.name === b.name && a.scope === b.scope

/** Snippet files projected into the host skill registry, where `@name` attachments resolve. */
export class SnippetService {
  private snippets: Snippet[] = []
  private fingerprint = "[]"
  private readonly serial = createSerialQueue()

  /** `refreshed` runs after every reread, such as to watch a snippet directory a write just created. */
  constructor(private readonly store: SnippetStore, private readonly skills: SkillHost, private readonly refreshed = () => {}) {}

  /** The synchronous skill transform; the host replays it on every rebuild. Existing skills keep their IDs. */
  register(editor: Pick<SkillEditor, "get" | "add">): void {
    // Skills registered before snippets keep their names, for references as for `@name` in a prompt. A later skill source
    // isn't known yet, so a reference to a name it takes still expands; entries() reports it.
    const keys = new Map([...effectiveSnippets(this.snippets)].filter(([key]) => !editor.get(key)))
    const content = new Map<Snippet, string>()
    for (const [key, snippet] of keys) {
      if (!content.has(snippet)) content.set(snippet, expandSnippet(snippet, keys).text)
      editor.add({
        id: Skill.ID.make(key),
        name: Skill.Name.make(skillName(key)),
        description: skillDescription(key, snippet),
        // Only the user attaches snippets; the model never sees them in its skill list.
        autoinvoke: false,
        path: Skill.Info.fields.path.make(snippet.path),
        // References expand here, so the text attached at send time carries each referenced snippet's current text.
        content: content.get(snippet)!,
      })
    }
  }

  /** Rereads the files, including edits made outside OpenCode, and reloads skills only when something changed. */
  refresh(): Promise<void> {
    return this.serial(async () => {
      const snippets = await this.store.list()
      this.refreshed()
      const fingerprint = JSON.stringify(snippets)
      if (fingerprint === this.fingerprint) return
      this.snippets = snippets
      this.fingerprint = fingerprint
      await this.skills.reload()
    })
  }

  /** Typed names whose registered skill is this snippet. Later skill sources can replace a snippet's ID. */
  async available(): Promise<Map<string, Snippet>> {
    const registered = new Map((await this.skills.list()).data.map((skill) => [skill.id, skill]))
    return new Map([...effectiveSnippets(this.snippets)].filter(([key, snippet]) => {
      const skill = registered.get(key)
      return skill?.name === skillName(key) && skill.path === snippet.path
    }))
  }

  /** Snippet names and aliases another skill owns, so references to them stay as typed. */
  private async blocked(): Promise<Set<string>> {
    const available = await this.available()
    return new Set([...effectiveSnippets(this.snippets).keys()].filter((key) => !available.has(key)))
  }

  async entries(): Promise<SnippetEntry[]> {
    await this.refresh()
    const available = await this.available()
    const blocked = await this.blocked()
    const projectNames = new Set(this.snippets.filter((snippet) => snippet.scope === "project").map((snippet) => snippet.name))
    return this.snippets.map((snippet) => {
      const overridden = snippet.scope === "global" && projectNames.has(snippet.name)
      const expansion = expandSnippet(snippet, available)
      const breaks = newlyBroken(this.snippets, this.snippets.filter((other) => other !== snippet), blocked).map((other) => other.name)
      return { ...snippet, overridden, conflict: !overridden && available.get(snippet.name) !== snippet, expanded: expansion.text, problems: referenceProblems(expansion), breaks }
    })
  }

  /** Every snippet file, freshly read. */
  async list(): Promise<Snippet[]> {
    await this.refresh()
    return this.snippets
  }

  /** Checks a save without writing, so an approval is never spent on one that would fail. Errors say what to change. */
  async prepare(request: SaveRequest): Promise<PreparedSave> {
    await this.refresh()
    const { name, scope, from } = request
    const snippets = this.snippets
    const fields = validateSnippet(name, request.fields)
    const source = from && snippets.find((snippet) => same(snippet, from))
    if (from && !source) throw new Error(`No ${from.scope} snippet named ${from.name}.`)
    const existing = snippets.find((snippet) => same(snippet, { name, scope }))
    if (existing && existing !== source && !request.replace) throw new Error(`There is already a ${scope} snippet named ${name}.`)
    const others = snippets.filter((snippet) => snippet !== source)
    const owner = effectiveSnippets(others).get(name)
    if (owner && owner.name !== name) throw new Error(`${name} is an alias of @${owner.name}. Use another name, or change @${owner.name}.`)
    const taken = takenAliases(others, { name, scope, aliases: fields.aliases })
    if (taken.length) throw new Error(`These aliases would not insert @${name}: ${taken.map(([alias, other]) => `${alias} inserts @${other.name} (${other.scope})`).join(", ")}. Drop or rename them.`)
    const blocked = await this.blocked()
    const expansion = expandWrite(others, { name, scope, ...fields }, blocked)
    const problems = referenceProblems(expansion)
    if (problems.length) {
      const projectOnly = scope === "global" && expansion.missing.some((key) => effectiveSnippets(snippets).get(key)?.scope === "project")
      throw new Error(`@${name} would not expand: ${problems.join(" ")}${projectOnly ? " A global snippet can only use global snippets." : ""}`)
    }
    const written: Snippet = { name, scope, path: "", ...fields }
    const after = [...others.filter((snippet) => !same(snippet, written)), written]
    const breaks = newlyBroken(snippets, after, blocked).map((snippet) => snippet.name)
    return { name, scope, fields, ...from ? { from } : {}, expanded: expansion.text, breaks }
  }

  /** Writes a prepared save, then removes the snippet it was renamed or moved from. */
  async commit(save: PreparedSave): Promise<string> {
    const path = await this.store.write(save.scope, save.name, save.fields)
    if (save.from && !same(save.from, save)) await this.store.remove(save.from.scope, save.from.name)
    await this.refresh()
    return path
  }

  /** The snippet a delete would remove and the snippets it would break, or an error that says why there is none. */
  async prepareRemove(key: SnippetKey): Promise<{ snippet: Snippet; breaks: string[] }> {
    await this.refresh()
    const snippet = this.snippets.find((other) => same(other, key))
    if (!snippet) {
      const owner = effectiveSnippets(this.snippets).get(key.name)
      if (owner && owner.name !== key.name) throw new Error(`${key.name} is an alias of @${owner.name}. Delete ${owner.name} (${owner.scope}) instead.`)
      const other = this.snippets.find((candidate) => candidate.name === key.name)
      throw new Error(`No ${key.scope} snippet named ${key.name}${other ? `; there is a ${other.scope} one` : ""}.`)
    }
    const breaks = newlyBroken(this.snippets, this.snippets.filter((other) => other !== snippet), await this.blocked()).map((other) => other.name)
    return { snippet, breaks }
  }

  async remove(scope: Scope, name: string): Promise<boolean> {
    const removed = await this.store.remove(scope, name)
    await this.refresh()
    return removed
  }
}
