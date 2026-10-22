---
"@lidtop/opencode-context": patch
"@lidtop/opencode-cost": patch
"@lidtop/opencode-later": patch
"@lidtop/opencode-sessions": patch
---
Context and Cost now share one coalesced refresh from the bundled core utilities. Cost dashboard reads time out after 30 seconds instead of blocking later refreshes, and refresh-failure warnings in both stay visible until a retry succeeds. Later and Sessions only rebuild against the updated shared core.
