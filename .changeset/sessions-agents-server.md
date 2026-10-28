---
"@lidtop/opencode-sessions": patch
---

The Agents sidebar now comes from the OpenCode server, so every terminal connected to it lists the same sessions, in the same order, with the same states, and a finish you've seen in one terminal counts as seen in all of them. Each terminal still leaves out the session it's on, keeps its own back trail, and alerts once per new request or finish when `inbox.notify` is on. `inbox.keepRead` is now a server option (`opencode.json(c)`, not `cli.json`); `inbox.rows`, `inbox.notify`, and `inbox.enabled` stay terminal options. The sidebar needs the server plugin, as the browser already did. The time a run was first seen is known only if the server plugin was running then, and is not kept across a server restart.
