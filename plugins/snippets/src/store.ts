import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { errorMessage } from "@opcode/core"
import { formatSnippet, MAX_BODY, parseSnippet, scopes, validateSnippet, validName, type Scope, type Snippet, type SnippetFields } from "./domain"

export function snippetDirectories(
  location: { directory: string; project: { id: string; directory: string } },
  env: NodeJS.ProcessEnv = process.env, home = homedir(),
): Record<Scope, string> {
  // Outside a repository the project is the global one, whose directory is not this project.
  const project = location.project.id === "global" ? location.directory : location.project.directory
  return {
    global: join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "snippets"),
    project: join(project, ".opencode", "snippets"),
  }
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT"

/**
 * Markdown files named after their snippet. Global files may be symlinks, as in a dotfiles checkout; a repository's
 * project snippets must be regular files, so a cloned repository cannot point `#review` at a file elsewhere.
 */
export class SnippetStore {
  constructor(readonly directories: Record<Scope, string>) {}

  path(scope: Scope, name: string): string {
    if (!validName(name)) throw new Error(`Invalid snippet name "${name}". Use lowercase letters, digits, and single hyphens, with at least one letter.`)
    return join(this.directories[scope], `${name}.md`)
  }

  /** `.opencode` and `.opencode/snippets` must be real directories too, or a repository could point them anywhere. */
  private async linked(scope: Scope): Promise<boolean> {
    if (scope === "global") return false
    for (const path of [dirname(this.directories.project), this.directories.project]) {
      const info = await lstat(path).catch((error) => { if (missing(error)) return undefined; throw error })
      if (info?.isSymbolicLink()) return true
    }
    return false
  }

  private async file(scope: Scope, path: string) {
    return await (scope === "global" ? stat : lstat)(path).catch((error) => { if (missing(error)) return undefined; throw error })
  }

  /** An unreadable directory is reported and skipped, so the other scope still works. */
  async list(): Promise<Snippet[]> {
    const snippets: Snippet[] = []
    for (const scope of scopes) {
      const entries = await this.linked(scope).then((linked) => {
        if (linked) throw new Error("project snippet directories cannot be symlinks")
        return readdir(this.directories[scope])
      }).catch((error) => {
        if (!missing(error)) console.warn(`opcode-snippets: cannot read ${this.directories[scope]}: ${errorMessage(error)}`)
        return []
      })
      for (const entry of entries.sort()) {
        const name = entry.endsWith(".md") ? entry.slice(0, -3) : ""
        if (!validName(name)) continue
        const path = join(this.directories[scope], entry)
        const info = await this.file(scope, path).catch(() => undefined)
        if (!info?.isFile() || info.size > MAX_BODY * 2) continue
        const text = await readFile(path, "utf8").catch(() => undefined)
        if (text !== undefined) snippets.push({ name, scope, path, ...parseSnippet(text) })
      }
    }
    return snippets
  }

  /** Replaces the file atomically, so a reader sees the old or the new snippet and never part of one. */
  async write(scope: Scope, name: string, fields: SnippetFields): Promise<string> {
    const path = this.path(scope, name)
    const text = formatSnippet(validateSnippet(name, fields))
    if (await this.linked(scope)) throw new Error(`${this.directories[scope]} and its parent cannot be symlinks.`)
    const existing = await this.file(scope, path)
    if (existing && !existing.isFile()) throw new Error(`${path} is not a regular file.`)
    // A symlinked global snippet is updated where it points, keeping the link.
    const target = existing && scope === "global" ? await realpath(path) : path
    await mkdir(dirname(target), { recursive: true })
    const temporary = join(dirname(target), `.${name}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, text, { flag: "wx" })
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    return path
  }

  async remove(scope: Scope, name: string): Promise<boolean> {
    const path = this.path(scope, name)
    if (!(await this.file(scope, path))?.isFile()) return false
    await rm(path)
    return true
  }
}
