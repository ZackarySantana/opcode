# @lidtop/opencode-cost

## 0.4.0

### Minor Changes

- 57063c7: Add an OpenCode Desktop part: a titlebar pill with today's spend, and a Cost dashboard (command palette and `/cost`) with the terminal's totals, models, projects, days, and longest turns. The server emits a throttled `updated` RPC event when it records usage.
- 62c9603: Require OpenCode 2.2.0 and OpenTUI 0.7.

## 0.3.3

### Patch Changes

- 5ccffe8: Shared code moved into helpers every plugin bundles: the refresh schedule now also works outside the terminal, and there are new helpers for state shared by a server's projects, RPC contracts and handlers, and following a server's state. For Context, Feed, Later, and Media nothing changes. In Cost, Review, Snippets, and Sessions, a call the terminal aborted is no longer reported as a failure. In Sessions, every project open on a server now shares one search index connection and one writer per database file, rather than possibly one per project.
- e91635a: Shared code that Feed and GH PR Status use moved into helpers every plugin bundles: the minute clock that ages views, and sending changes to the server in order while showing them at once. Nothing changes for any plugin.

## 0.3.2

### Patch Changes

- abc551c: The shared live-event helper can now resubscribe to an event stream that stops delivering, for the Sessions sidebar. No behavior changes.

## 0.3.1

### Patch Changes

- e5df44d: The README opens with a short demo video.

## 0.3.0

### Minor Changes

- 2b142b5: `/cost` is now a dialog, like `/feed` and `/ghpr`, with one search box and an in-dialog date range picker (`d`). Opening a longest turn closes the dialog and opens its session. Amounts show tokens beside cost; a view with no recorded cost, as on a subscription, hides cost and shows only tokens, and breakdowns rank cost ties by tokens.
- 3f3b12d: `/cost` has Overview, Models, Projects, Daily, and Turns tabs instead of panels stacked in one view. The Overview holds every total; each breakdown row shows its usage and its time together, and lists every model (now split by variant, as on the time side), project, and date in the range rather than the top eight or newest 14. ↑/↓ select rows one at a time and scroll to keep the selection in view; enter on a turn still opens its session. The date range (`d`) is the only filter: the project and model pickers and `x` reset are gone, along with the server's project/model filter parameters and picker options.
- 47f719c: Add time to `/cost`: agent working time per turn, time waiting on you (at most 30 minutes per wait), parallel time across root sessions with its peak, breakdowns by model/variant, project, and day, and the longest turns, which open their session. Delete the existing Cost database and its SQLite sidecars before upgrading; the history import rebuilds usage and backfills turn timing.

### Patch Changes

- 0c50ac8: Keep the Overview cards inside the `/cost` dialog, and leave a blank line between rows in the list tabs.
- bb097fd: Require OpenCode 2.1.3 or newer.
- 1708674: Move Later's prompt paste helper into the shared UI package so Snippets can reuse it. No behavior changes.
- 44bad65: The Pull requests and Feeds sidebar sections show their refresh countdown beside the title instead of on a line of their own. Those sections and Agents no longer add a line saying there's nothing to show; they show just the title.
- f27f920: The shared item card can lead with its title when an item has no head, for Later. No behavior changes.

## 0.2.4

### Patch Changes

- 439c23e: Tag the package with the `opencode` and `opencode-plugin` npm keywords so plugin directories such as OpenDock can list it.

## 0.2.3

### Patch Changes

- a8e520d: Standardize the package READMEs: install with `opencode plugin add` first, show screenshots, and use the same sections and wording across every plugin.

## 0.2.2

### Patch Changes

- e6b5093: Context no longer lets missing, negative, or non-finite provider usage values corrupt its token totals. History pagination, live-event reconnection, and usage normalization now behave consistently across plugins, and Cost always closes its ledger on unload. Errors with an empty message now show a readable fallback instead of a blank notification.
- 6eaeb52: Context and Cost now share one coalesced refresh from the bundled core utilities. Cost dashboard reads time out after 30 seconds instead of blocking later refreshes, and refresh-failure warnings in both stay visible until a retry succeeds. Later and Sessions only rebuild against the updated shared core.
- ea7786e: Send the history message-type filter only on the first page, so sessions with many assistant messages import without the cursor being rejected.
- 2c29af6: History import now asks the server only for assistant and compaction messages, and briefly reuses the last session authorization instead of re-checking it for every batch.
- 0eb7423: Switching location now cancels the previous location's history import, and an import failure is shown only for the location it happened in; `r` retries the current location.
- 937ef26: Keep recorded cost when a retried step later fails without reporting usage, instead of overwriting it with zero.
- b7779fb: Show the actual reason when a server-side cost request fails, and stop slow session lookups from delaying dashboard reads and live collection.
- 2ae4cb3: Aggregate the dashboard in SQLite rather than scanning every recorded message, and label each project by its most recently used directory.
- 1ae9d93: Create new Cost and Later databases owner-only (0600 files in a 0700 directory) before SQLite writes to them, as Sessions already did; existing database permissions are left unchanged. All plugins now share one XDG state-path resolver.
- e70e939: Measure and truncate labels with the host renderer's width method in every plugin, so Cost project, model, and warning labels no longer overflow with wide characters such as CJK or emoji. Cost, Later, and Sessions keyboard hints with a matching command are now clickable, and all views take their colors from the shared theme palette.

## 0.2.1

### Patch Changes

- da30824: Show the cost dashboard's daily activity newest date first while retaining the latest 14 dates and complete usage totals.

## 0.2.0

### Minor Changes

- 805bb55: Publish independently versioned OpenCode V2 plugins with bundled private helpers and terminal extensions.

### Patch Changes

- 8f1a01b: Balance theme colors: use normal foreground for page/dialog titles and shortcut keys, muted labels and neutral borders, accent hues for sections/charts, and interactive hues for values. Preserve the theme's contrasting selection foreground/background pair.
- 4b98516: Show project paths instead of opaque project IDs beside names in the cost dashboard's project picker, matching the Sessions browser. Keep filtering by stable project ID across worktrees.
- 572b6e9: Restore consistent theme-aware colors for headings, borders, metrics, keyboard hints, charts, and statuses. Follow live light/dark theme changes and preserve dialog and selection colors.
