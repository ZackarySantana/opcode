---
"@lidtop/opencode-context": patch
"@lidtop/opencode-cost": patch
"@lidtop/opencode-feed": patch
"@lidtop/opencode-later": patch
"@lidtop/opencode-media": patch
"@lidtop/opencode-review": patch
"@lidtop/opencode-sessions": patch
"@lidtop/opencode-snippets": patch
---

Shared code moved into helpers every plugin bundles: the refresh schedule now also works outside the terminal, and there are new helpers for state shared by a server's projects, RPC contracts and handlers, and following a server's state. For Context, Feed, Later, and Media nothing changes. In Cost, Review, Snippets, and Sessions, a call the terminal aborted is no longer reported as a failure. In Sessions, every project open on a server now shares one search index connection and one writer per database file, rather than possibly one per project.
