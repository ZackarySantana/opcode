---
"@lidtop/opencode-sessions": patch
---

Finished and failed sessions stay in the Agents sidebar for 10 minutes after you first open them, with a muted mark, instead of dropping out right away. They keep their place and their number for `/go` while listed. Set `inbox.keepRead` in `cli.json` to a different number of minutes, or `0` to drop them as soon as you open them.
