import { createSerialQueue } from "@opcode/core"
import { Skill } from "@opencode/plugin"
import type { SkillEditor } from "@opencode/plugin/promise/skill"
import { effectiveSnippets, skillDescription, skillName, type Scope, type Snippet, type SnippetFields } from "./domain"
import type { SnippetStore } from "./store"

export interface SnippetEntry extends Snippet {
  /** A project snippet with the same name replaces this global one. */
  overridden: boolean
  /** Another skill owns this name, so neither `@name` nor `#name` inserts the snippet. */
  conflict: boolean
}

export interface SkillHost {
  reload(): Promise<void>
  list(): Promise<{ data: readonly { id: string; name: string; path: string }[] }>
}

/** Snippet files projected into the host skill registry, where `@name` and `#name` attachments resolve. */
export class SnippetService {
  private snippets: Snippet[] = []
  private fingerprint = "[]"
  private readonly serial = createSerialQueue()

  constructor(private readonly store: SnippetStore, private readonly skills: SkillHost) {}

  /** The synchronous skill transform; the host replays it on every rebuild. Existing skills keep their IDs. */
  register(editor: Pick<SkillEditor, "get" | "add">): void {
    for (const [key, snippet] of effectiveSnippets(this.snippets)) {
      if (editor.get(key)) continue
      editor.add({
        id: Skill.ID.make(key),
        name: Skill.Name.make(skillName(key)),
        description: skillDescription(key, snippet),
        // Only the user attaches snippets; the model never sees them in its skill list.
        autoinvoke: false,
        path: Skill.Info.fields.path.make(snippet.path),
        content: snippet.body,
      })
    }
  }

  /** Rereads the files, including edits made outside OpenCode, and reloads skills only when something changed. */
  refresh(): Promise<void> {
    return this.serial(async () => {
      const snippets = await this.store.list()
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

  async entries(): Promise<SnippetEntry[]> {
    await this.refresh()
    const available = await this.available()
    const projectNames = new Set(this.snippets.filter((snippet) => snippet.scope === "project").map((snippet) => snippet.name))
    return this.snippets.map((snippet) => {
      const overridden = snippet.scope === "global" && projectNames.has(snippet.name)
      return { ...snippet, overridden, conflict: !overridden && available.get(snippet.name) !== snippet }
    })
  }

  /** The snippet a name or alias currently means. */
  async get(name: string): Promise<Snippet | undefined> {
    await this.refresh()
    return effectiveSnippets(this.snippets).get(name)
  }

  async write(scope: Scope, name: string, fields: SnippetFields): Promise<string> {
    const path = await this.store.write(scope, name, fields)
    await this.refresh()
    return path
  }

  async remove(scope: Scope, name: string): Promise<boolean> {
    const removed = await this.store.remove(scope, name)
    await this.refresh()
    return removed
  }
}
