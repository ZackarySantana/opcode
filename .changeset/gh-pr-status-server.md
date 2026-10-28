---
"@lidtop/opencode-gh-pr-status": patch
---

GH PR Status now runs on the OpenCode server, so every terminal connected to it shows the same pull requests and settings, and GitHub is polled once for all of them instead of once per terminal. A change to a setting or the Teams tab's filter, or a refresh with `r`, shows in every terminal right away, and the sidebar's countdown follows the server's schedule. Configure the plugin where the server reads plugins (`opencode.json(c)`, not `cli.json`), with `gh` installed and signed in on the server's machine; `/ghpr-comments` reads the session's branch there too. `commentsPrompt` is now a server option, and the `database` option is gone: settings live in the server's plugin storage. Settings saved by earlier versions are not carried over and start at the defaults; you can delete `opcode-gh-pr-status/gh-pr-status.sqlite` in the terminal's OpenCode state directory.
