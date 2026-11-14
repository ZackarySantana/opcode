---
"@lidtop/opencode-review": minor
---

Review follows an agent into its worktree. When the agent changes files or runs commands in a worktree other than its session's directory, Review reviews that worktree, as Uncommitted (OpenCode's snapshots don't cover it), and names it in the header. Usages, opened files, and questions go there too. **Worktree...** in the options picks a checkout for the session, and the diff now reloads when a session moves.
