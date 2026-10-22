---
"@lidtop/opencode-sessions": patch
---

Keep history import working when the TUI and server run different Sessions versions, and stop dropping the legacy per-message revision table so older processes sharing the index keep writing.
