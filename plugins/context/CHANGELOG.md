# @lidtop/opencode-context

## 0.2.2

### Patch Changes

- 3022092: Cache read efficiency now counts cache writes as recorded input, matching the Recorded input card.
- b3fe9a8: Refresh `/context` only on completed session events instead of every streamed chunk, reload environment and catalog data only on open and `r`, time out stuck refreshes, and report history as unavailable when neither live nor cached history exists.
- ba5a440: Export redaction now catches prefixed secret names (`OPENAI_API_KEY=`, `GITHUB_TOKEN=`, `client_secret=`), credentials in non-HTTP URLs (`postgres://`, `mongodb+srv://`), `gsk_`/`hf_`/`AIza` keys, `key=` query parameters, and no longer leaves a stray `]` after `Authorization: Bearer` values.
- e6b5093: Context no longer lets missing, negative, or non-finite provider usage values corrupt its token totals. History pagination, live-event reconnection, and usage normalization now behave consistently across plugins, and Cost always closes its ledger on unload. Errors with an empty message now show a readable fallback instead of a blank notification.
- 6eaeb52: Context and Cost now share one coalesced refresh from the bundled core utilities. Cost dashboard reads time out after 30 seconds instead of blocking later refreshes, and refresh-failure warnings in both stay visible until a retry succeeds. Later and Sessions only rebuild against the updated shared core.
- 1ae9d93: Create new Cost and Later databases owner-only (0600 files in a 0700 directory) before SQLite writes to them, as Sessions already did; existing database permissions are left unchanged. All plugins now share one XDG state-path resolver.
- e70e939: Measure and truncate labels with the host renderer's width method in every plugin, so Cost project, model, and warning labels no longer overflow with wide characters such as CJK or emoji. Cost, Later, and Sessions keyboard hints with a matching command are now clickable, and all views take their colors from the shared theme palette.

## 0.2.1

### Patch Changes

- e2b016b: Let history pagination cursors carry the sort order after the first page. Prevent OpenCode from rejecting subsequent pages and incorrectly showing a degraded cached-history warning.

## 0.2.0

### Minor Changes

- 805bb55: Publish independently versioned OpenCode V2 plugins with bundled private helpers and terminal extensions.

### Patch Changes

- 8f1a01b: Balance theme colors: use normal foreground for page/dialog titles and shortcut keys, muted labels and neutral borders, accent hues for sections/charts, and interactive hues for values. Preserve the theme's contrasting selection foreground/background pair.
- 572b6e9: Restore consistent theme-aware colors for headings, borders, metrics, keyboard hints, charts, and statuses. Follow live light/dark theme changes and preserve dialog and selection colors.
