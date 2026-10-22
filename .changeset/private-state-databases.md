---
"@lidtop/opencode-context": patch
"@lidtop/opencode-cost": patch
"@lidtop/opencode-later": patch
"@lidtop/opencode-sessions": patch
---

Create new Cost and Later databases owner-only (0600 files in a 0700 directory) before SQLite writes to them, as Sessions already did; existing database permissions are left unchanged. All plugins now share one XDG state-path resolver.
