# @lidtop/opencode-sessions

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
