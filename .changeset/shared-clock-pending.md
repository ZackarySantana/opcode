---
"@lidtop/opencode-context": patch
"@lidtop/opencode-cost": patch
"@lidtop/opencode-gh-pr-status": patch
"@lidtop/opencode-later": patch
"@lidtop/opencode-media": patch
"@lidtop/opencode-review": patch
"@lidtop/opencode-sessions": patch
"@lidtop/opencode-snippets": patch
---

Shared code that Feed and GH PR Status use moved into helpers every plugin bundles: the minute clock that ages views, and sending changes to the server in order while showing them at once. Nothing changes for any plugin.
