/**
 * Which worktree an agent works in, from the paths its tools touched. An agent that makes a worktree and works there
 * without moving its session leaves the session's own directory unchanged: its snapshots and `git diff` there show
 * none of the work. Knows nothing about the host.
 */

import type { SessionMessageInfo } from "@opencode/client"

/** Tools whose `path` is a file they change, or `workdir` a directory they run in: where the agent works. */
const WORKING = new Set(["edit", "write", "shell"])
/** Tools that only look: a hint, when nothing was changed or run anywhere. */
const LOOKING = new Set(["read", "glob", "grep"])
const PATCHED = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

const absolute = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
const normalize = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "")

/** The absolute paths a tool call worked in, and whether it changed or ran something there. */
function touched(name: string, input: unknown): { paths: string[]; working: boolean } {
  if (!input || typeof input !== "object") return { paths: [], working: false }
  const fields = input as Record<string, unknown>
  const strings = (...values: unknown[]) => values.flatMap((value) => typeof value === "string" && absolute(value) ? [value] : [])
  if (name === "patch" && typeof fields.patchText === "string") return { paths: strings(...[...fields.patchText.matchAll(PATCHED)].map((match) => match[1]!.trim())), working: true }
  if (name === "shell") return { paths: strings(fields.workdir), working: true }
  if (WORKING.has(name) || LOOKING.has(name)) return { paths: strings(fields.path), working: WORKING.has(name) }
  return { paths: [], working: false }
}

/** The worktree holding a path: the deepest one it's inside, as worktrees can sit inside the main checkout. */
export function worktreeOf(path: string, worktrees: readonly string[]): string | undefined {
  const target = normalize(path)
  return worktrees.map(normalize).filter((root) => target === root || target.startsWith(`${root}/`)).sort((a, b) => b.length - a.length)[0]
}

/**
 * The worktree the agent worked in most recently, when it isn't the session's own: where it last changed or ran
 * something, else where it last looked. Paths in no known worktree are returned in `unknown`, so the caller can
 * look for worktrees made since it listed them.
 */
export function detectWorktree(messages: readonly SessionMessageInfo[], own: string, worktrees: readonly string[]): { worktree?: string; unknown: boolean } {
  const home = worktreeOf(own, worktrees) ?? normalize(own)
  let looked: string | undefined
  let unknown = false
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type !== "assistant") continue
    for (let part = message.content.length - 1; part >= 0; part--) {
      const content = message.content[part]!
      if (content.type !== "tool" || content.state.status === "streaming") continue
      const { paths, working } = touched(content.name, content.state.input)
      for (const path of paths) {
        const root = worktreeOf(path, worktrees)
        if (!root) { unknown = true; continue }
        if (working) return { worktree: root === home ? undefined : root, unknown }
        looked ??= root
      }
    }
  }
  return { worktree: looked === undefined || looked === home ? undefined : looked, unknown }
}
