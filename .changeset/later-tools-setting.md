---
"@lidtop/opencode-later": minor
---

Add an **Agent tools** setting to `/later` Settings, on by default. Turned off, sessions created afterward don't get the Later tools, and older sessions keep them listed (so their prompt cache still applies) but every call is refused. Turning them back on asks first, because each open session's next message then misses the prompt cache once.
