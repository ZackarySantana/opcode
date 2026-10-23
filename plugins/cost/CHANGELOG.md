# @lidtop/opencode-cost

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
