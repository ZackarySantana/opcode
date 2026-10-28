# @lidtop/opencode-sessions

## 0.3.2

### Patch Changes

- 5ccffe8: Shared code moved into helpers every plugin bundles: the refresh schedule now also works outside the terminal, and there are new helpers for state shared by a server's projects, RPC contracts and handlers, and following a server's state. For Context, Feed, Later, and Media nothing changes. In Cost, Review, Snippets, and Sessions, a call the terminal aborted is no longer reported as a failure. In Sessions, every project open on a server now shares one search index connection and one writer per database file, rather than possibly one per project.
- 1321e5b: The Agents sidebar now comes from the OpenCode server, so every terminal connected to it lists the same sessions, in the same order, with the same states, and a finish you've seen in one terminal counts as seen in all of them. Each terminal still leaves out the session it's on, keeps its own back trail, and alerts once per new request or finish when `inbox.notify` is on. `inbox.keepRead` is now a server option (`opencode.json(c)`, not `cli.json`); `inbox.rows`, `inbox.notify`, and `inbox.enabled` stay terminal options. The sidebar needs the server plugin, as the browser already did. The time a run was first seen is known only if the server plugin was running then, and is not kept across a server restart.
- e91635a: Shared code that Feed and GH PR Status use moved into helpers every plugin bundles: the minute clock that ages views, and sending changes to the server in order while showing them at once. Nothing changes for any plugin.

## 0.3.1

### Patch Changes

- abc551c: Finished and failed sessions stay in the Agents sidebar for 10 minutes after you first open them, with a muted mark, instead of dropping out right away. They keep their place and their number for `/go` while listed. Set `inbox.keepRead` in `cli.json` to a different number of minutes, or `0` to drop them as soon as you open them.
- abc551c: The Agents sidebar no longer freezes when its event stream silently stops delivering, which left finished sessions listed as working, missed new ones, and kept sessions you had opened. Like OpenCode itself, it now reconnects after 45 seconds without even a keepalive and reloads the list.

## 0.3.0

### Minor Changes

- f5d0ff2: Add an Agents section at the top of the sidebar listing active sessions across all projects: working, retrying, waiting on you, or finished or failed since you last looked, with subagents rolled up into their session. Rows keep the order they became active; click one or run `/go <n>` to open it, and `/go back` (or the Back row) to return. Optional notifications for new requests and finished runs are off by default; configure everything under `inbox` in `cli.json`. `/sessions` now opens sessions from other directories directly instead of copying a resume command.
- a5ede26: `/sessions` opens as an extra-large dialog with more room for titles and a wider preview. `/back` and `/previous` return along the back trail, like the sidebar's **Back to …** row. Other plugins can dispatch `opcode-sessions.navigate` with a session ID to open it while recording the back trail.

### Patch Changes

- bb097fd: Require OpenCode 2.1.3 or newer.
- fe9d281: Remove the `/opcode-sessions` and `/opcode-go` slash names. Use `/sessions`, `/sessions-all`, or `/all-sessions` to browse sessions, and `/go` for active sessions. When `/go` belongs to another command, use **Go to active session** in the command palette.
- 14bdfde: The Agents sidebar, `/go`, and its list no longer include the session you're in.
- 2549f8e: Hide the Agents sidebar section while there are no active sessions and no way back.
- e7e3fcb: `/sessions` opens as a large centered dialog, like `/feed` and `/ghpr`, instead of a full-screen page. The search box filters as you type, `p` picks a project in place, and `esc` steps back one filter at a time before closing.
- 1708674: Move Later's prompt paste helper into the shared UI package so Snippets can reuse it. No behavior changes.
- 44bad65: The Pull requests and Feeds sidebar sections show their refresh countdown beside the title instead of on a line of their own. Those sections and Agents no longer add a line saying there's nothing to show; they show just the title.
- e85fab8: The shared tabbed dialog can keep its open tab when shown again, for Later. No behavior changes.
- f27f920: The shared item card can lead with its title when an item has no head, for Later. No behavior changes.

## 0.2.3

### Patch Changes

- 439c23e: Tag the package with the `opencode` and `opencode-plugin` npm keywords so plugin directories such as OpenDock can list it.

## 0.2.2

### Patch Changes

- a8e520d: Standardize the package READMEs: install with `opencode plugin add` first, show screenshots, and use the same sections and wording across every plugin.

## 0.2.1

### Patch Changes

- e6b5093: Context no longer lets missing, negative, or non-finite provider usage values corrupt its token totals. History pagination, live-event reconnection, and usage normalization now behave consistently across plugins, and Cost always closes its ledger on unload. Errors with an empty message now show a readable fallback instead of a blank notification.
- 6eaeb52: Context and Cost now share one coalesced refresh from the bundled core utilities. Cost dashboard reads time out after 30 seconds instead of blocking later refreshes, and refresh-failure warnings in both stay visible until a retry succeeds. Later and Sessions only rebuild against the updated shared core.
- 1ae9d93: Create new Cost and Later databases owner-only (0600 files in a 0700 directory) before SQLite writes to them, as Sessions already did; existing database permissions are left unchanged. All plugins now share one XDG state-path resolver.
- e70e939: Measure and truncate labels with the host renderer's width method in every plugin, so Cost project, model, and warning labels no longer overflow with wide characters such as CJK or emoji. Cost, Later, and Sessions keyboard hints with a matching command are now clickable, and all views take their colors from the shared theme palette.
- ea7786e: Keep history import working when the TUI and server run different Sessions versions, and stop dropping the legacy per-message revision table so older processes sharing the index keep writing.
- 613bcf8: Make session indexing resilient. A busy or failing session no longer aborts a refresh or skips deletion reconciliation; busy sessions are retried quietly once idle, and counts are reported. History import skips deleted or changed sessions and leaves out (and counts) messages over 1 MiB instead of stopping. Unchanged sessions are skipped on refresh and history import, overlapping refreshes are coalesced, and history now synchronizes the first time the browser opens rather than on every TUI launch. Reverted messages are removed from the index while compacted history stays searchable. Index writes use immediate SQLite transactions, so a second writer cannot abort them; descendants of deleted sessions stay deleted; and tombstones no longer hide a session the server later returns. The index enables SQLite `secure_delete`.
- 613bcf8: Improve search. Expensive expressions return the matches found before the time budget, marked partial, instead of failing. Searches no longer wait behind index writes and reuse one regex worker. Titles, directories, and messages are matched separately so anchors such as `^/home` work, Unicode mode is used when the expression allows it, and the 256-character limit counts characters. Previews center on the match without splitting graphemes. Enter now opens the selected session while results refresh in the background.

## 0.2.0

### Minor Changes

- 805bb55: Publish independently versioned OpenCode V2 plugins with bundled private helpers and terminal extensions.

### Patch Changes

- 8f1a01b: Balance theme colors: use normal foreground for page/dialog titles and shortcut keys, muted labels and neutral borders, accent hues for sections/charts, and interactive hues for values. Preserve the theme's contrasting selection foreground/background pair.
- 572b6e9: Restore consistent theme-aware colors for headings, borders, metrics, keyboard hints, charts, and statuses. Follow live light/dark theme changes and preserve dialog and selection colors.
