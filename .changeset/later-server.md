---
"@lidtop/opencode-later": patch
---

Later now keeps its list on the OpenCode server, so every terminal connected to it and the agent in every project share one list and its settings, and a change anywhere shows in every sidebar and `/later` dialog right away. With a remote server, the agent's tools now change the list in your sidebar rather than a separate one on that machine. Configure the plugin where the server reads plugins (`opencode.json(c)`, not `cli.json`). The `database` option is gone: the list lives in the server's plugin storage. The list saved by earlier versions is not carried over; re-add the items you want to keep, then you can delete `opencode-later/later.sqlite` in the terminal's OpenCode state directory.
