---
"@lidtop/opencode-context": patch
---
Refresh `/context` only on completed session events instead of every streamed chunk, reload environment and catalog data only on open and `r`, time out stuck refreshes, and report history as unavailable when neither live nor cached history exists.
