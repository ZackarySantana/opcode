import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { detectWorktree, worktreeOf } from "../src/worktrees"

const own = "/repo"
const worktrees = ["/repo", "/wt/feature", "/wt/fix", "/repo/.worktrees/nested"]
const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool", name, id: name, time: { created: 1 }, state: { status: "completed", input, content: [{ type: "text", text: "" }] } })
const turn = (...tools: ReturnType<typeof tool>[]) => ({ type: "assistant", id: "msg", agent: "build", model: { id: "m", providerID: "p" }, time: { created: 1 }, content: tools }) as unknown as SessionMessageInfo
const detect = (...messages: SessionMessageInfo[]) => detectWorktree(messages, own, worktrees)

test("the worktree is where the agent last changed files or ran commands, by edit, write, patch, or a shell's workdir", () => {
  expect(detect(turn(tool("edit", { path: "/wt/feature/src/a.ts" })))).toEqual({ worktree: "/wt/feature", unknown: false })
  expect(detect(turn(tool("shell", { command: "bun test", workdir: "/wt/fix" })))).toEqual({ worktree: "/wt/fix", unknown: false })
  expect(detect(turn(tool("patch", { patchText: "*** Begin Patch\n*** Update File: /wt/fix/b.ts\n@@\n-a\n+b\n*** End Patch" }))).worktree).toBe("/wt/fix")
  // The latest work wins, and coming back to the session's own directory ends it.
  expect(detect(turn(tool("write", { path: "/wt/feature/a.ts" })), turn(tool("shell", { command: "ls", workdir: "/wt/fix" }))).worktree).toBe("/wt/fix")
  expect(detect(turn(tool("write", { path: "/wt/feature/a.ts" })), turn(tool("edit", { path: "/repo/a.ts" }))).worktree).toBeUndefined()
})

test("reads only count when nothing was changed or run, relative paths are the session's own, and unknown places are flagged", () => {
  expect(detect(turn(tool("read", { path: "/wt/feature/a.ts" }))).worktree).toBe("/wt/feature")
  expect(detect(turn(tool("edit", { path: "/wt/fix/a.ts" })), turn(tool("read", { path: "/wt/feature/a.ts" }))).worktree).toBe("/wt/fix")
  expect(detect(turn(tool("edit", { path: "src/a.ts" }), tool("shell", { command: "ls" })))).toEqual({ unknown: false })
  expect(detect(turn(tool("edit", { path: "/tmp/new-worktree/a.ts" })))).toEqual({ unknown: true })
})

test("a path belongs to the deepest worktree holding it, so one inside the main checkout is told apart", () => {
  expect(worktreeOf("/repo/.worktrees/nested/a.ts", worktrees)).toBe("/repo/.worktrees/nested")
  expect(worktreeOf("/repo/src/a.ts", worktrees)).toBe("/repo")
  expect(worktreeOf("/wt/feature-two/a.ts", worktrees)).toBeUndefined()
})
