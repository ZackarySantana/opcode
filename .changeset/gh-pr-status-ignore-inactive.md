---
"@lidtop/opencode-gh-pr-status": patch
---

A new **Ignore inactive** setting (Off, 7 days, 14 days, 1 month, 3 months, 1 year) leaves a pull request out of `/ghpr` and the sidebar once it has gone that long without activity on GitHub, such as a push, comment, review, or review request. It defaults to 1 month. Settings saved by earlier versions can't be read: delete `opcode-gh-pr-status/gh-pr-status.sqlite` in OpenCode's state directory before upgrading.
