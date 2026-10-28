# @lidtop/opencode-context

## 0.3.5

### Patch Changes

- 5ccffe8: Shared code moved into helpers every plugin bundles: the refresh schedule now also works outside the terminal, and there are new helpers for state shared by a server's projects, RPC contracts and handlers, and following a server's state. For Context, Feed, Later, and Media nothing changes. In Cost, Review, Snippets, and Sessions, a call the terminal aborted is no longer reported as a failure. In Sessions, every project open on a server now shares one search index connection and one writer per database file, rather than possibly one per project.
- e91635a: Shared code that Feed and GH PR Status use moved into helpers every plugin bundles: the minute clock that ages views, and sending changes to the server in order while showing them at once. Nothing changes for any plugin.

## 0.3.4

### Patch Changes

- e5df44d: The README opens with a short demo video.

## 0.3.3

### Patch Changes

- bb097fd: Require OpenCode 2.1.3 or newer.
- 1708674: Move Later's prompt paste helper into the shared UI package so Snippets can reuse it. No behavior changes.
- 44bad65: The Pull requests and Feeds sidebar sections show their refresh countdown beside the title instead of on a line of their own. Those sections and Agents no longer add a line saying there's nothing to show; they show just the title.

## 0.3.2

### Patch Changes

- 439c23e: Tag the package with the `opencode` and `opencode-plugin` npm keywords so plugin directories such as OpenDock can list it.

## 0.3.1

### Patch Changes

- a8e520d: Standardize the package READMEs: install with `opencode plugin add` first, show screenshots, and use the same sections and wording across every plugin.

## 0.3.0

### Minor Changes

- 88b9cd1: Switch tabs with Tab/Shift+Tab instead of h/l and left/right, matching the other Opcode dialogs.

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
