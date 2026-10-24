---
"@lidtop/opencode-sessions": minor
---

Add an Agents section at the top of the sidebar listing active sessions across all projects: working, retrying, waiting on you, or finished or failed since you last looked, with subagents rolled up into their session. Rows keep the order they became active; click one or run `/go <n>` to open it, and `/go back` (or the Back row) to return. Optional notifications for new requests and finished runs are off by default; configure everything under `inbox` in `cli.json`. `/sessions` now opens sessions from other directories directly instead of copying a resume command.
