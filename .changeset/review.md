---
"@lidtop/opencode-review": minor
---

Add Review: `/review` opens the agent's changes in a panel beside the conversation, updating as it edits. Comment on a line or range, then send the drafts with `S` (or `esc`, which also closes the panel); they reach the running agent at its next step, with the file and lines attached. The agent replies to each with `review_reply`, shown under your comment, and a comment ending in `??` asks a question instead of a change. Review this turn, the whole session, uncommitted changes, or the branch against its base, and mark files viewed until their diff changes.
