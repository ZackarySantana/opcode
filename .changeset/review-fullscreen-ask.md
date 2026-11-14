---
"@lidtop/opencode-review": minor
---

The panel always opens full screen, in place of the conversation, so it looks the same on every terminal; `f` is gone, and `q` goes back to the conversation. New: press `a` on a line or range to ask about it, answered by the conversation's model without the agent seeing it. The answer streams in under the line, `x` dismisses it, and `esc` cancels one still being answered. Questions run in an archived session of their own, made on the first one: it can only read and search the repository, and its usage is recorded like any session's.
