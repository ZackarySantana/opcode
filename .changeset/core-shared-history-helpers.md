---
"@lidtop/opencode-context": patch
"@lidtop/opencode-cost": patch
"@lidtop/opencode-later": patch
"@lidtop/opencode-sessions": patch
---

Context no longer lets missing, negative, or non-finite provider usage values corrupt its token totals. History pagination, live-event reconnection, and usage normalization now behave consistently across plugins, and Cost always closes its ledger on unload. Errors with an empty message now show a readable fallback instead of a blank notification.
