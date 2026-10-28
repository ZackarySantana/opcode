# @lidtop/opencode-later

## 0.4.0

### Minor Changes

- 3b19c6f: Add an OpenCode Desktop part: a Later side panel tab (add, use, edit, reorder, complete, delete, and history), a launcher in the side panel's + menu with the active count, `/later` to toggle the tab, and a "N for later" pill above the prompt. Using an item inserts it into the prompt without submitting and completes it, unless it changed elsewhere first. It follows the same server-owned list as every terminal.
- 62c9603: Require OpenCode 2.2.0 and OpenTUI 0.7.

## 0.3.2

### Patch Changes

- 5ccffe8: Shared code moved into helpers every plugin bundles: the refresh schedule now also works outside the terminal, and there are new helpers for state shared by a server's projects, RPC contracts and handlers, and following a server's state. For Context, Feed, Later, and Media nothing changes. In Cost, Review, Snippets, and Sessions, a call the terminal aborted is no longer reported as a failure. In Sessions, every project open on a server now shares one search index connection and one writer per database file, rather than possibly one per project.
- 23e2ac6: Later now keeps its list on the OpenCode server, so every terminal connected to it and the agent in every project share one list and its settings, and a change anywhere shows in every sidebar and `/later` dialog right away. With a remote server, the agent's tools now change the list in your sidebar rather than a separate one on that machine. Configure the plugin where the server reads plugins (`opencode.json(c)`, not `cli.json`). The `database` option is gone: the list lives in the server's plugin storage. The list saved by earlier versions is not carried over; re-add the items you want to keep, then you can delete `opencode-later/later.sqlite` in the terminal's OpenCode state directory.
- e91635a: Shared code that Feed and GH PR Status use moved into helpers every plugin bundles: the minute clock that ages views, and sending changes to the server in order while showing them at once. Nothing changes for any plugin.

## 0.3.1

### Patch Changes

- e5df44d: The README opens with a short demo video.

## 0.3.0

### Minor Changes

- 889f494: The agent can now edit a Later item's text and restore a completed item, not only complete one: `later_edit` replaces `later_complete`. Edits don't ask, and the result in the transcript includes the previous text.
- e85fab8: `/later` is now a dialog in the format of `/feed` and `/ghpr`, with Later, History, and Settings tabs, search, and the same keys; `c` completes or restores an item, and `enter` closes the dialog and pastes the item into the prompt. The sidebar is quieter, lists 5 items by default (3 to 20 in Settings), and points to `/later` for the rest. When Later's server side is loaded, the agent can list, add, and complete Later items, and delete one after you approve it.
- e945860: Add an **Agent tools** setting to `/later` Settings, on by default. Turned off, sessions created afterward don't get the Later tools, and older sessions keep them listed (so their prompt cache still applies) but every call is refused. Turning them back on asks first, because each open session's next message then misses the prompt cache once.

### Patch Changes

- f27f920: `/later` cards start an item's text beside its number, with the age on the same line, and wrap long text under itself rather than under the number. History cards do the same beside their check mark.
- 76fed78: Show the Later sidebar's item numbers in the text color, with the items' text still muted.
- bb097fd: Require OpenCode 2.1.3 or newer.
- 1708674: Move Later's prompt paste helper into the shared UI package so Snippets can reuse it. No behavior changes.
- 44bad65: The Pull requests and Feeds sidebar sections show their refresh countdown beside the title instead of on a line of their own. Those sections and Agents no longer add a line saying there's nothing to show; they show just the title.

## 0.2.3

### Patch Changes

- 439c23e: Tag the package with the `opencode` and `opencode-plugin` npm keywords so plugin directories such as OpenDock can list it.
- 61dcef7: Later and Feed now place their sidebar sections below the ones OpenCode and other plugins add, so GH PR Status's Pull requests comes first. Between themselves, Later and Feed keep the order they're configured in.

## 0.2.2

### Patch Changes

- a8e520d: Standardize the package READMEs: install with `opencode plugin add` first, show screenshots, and use the same sections and wording across every plugin.

## 0.2.1

### Patch Changes

- e6b5093: Context no longer lets missing, negative, or non-finite provider usage values corrupt its token totals. History pagination, live-event reconnection, and usage normalization now behave consistently across plugins, and Cost always closes its ledger on unload. Errors with an empty message now show a readable fallback instead of a blank notification.
- 6eaeb52: Context and Cost now share one coalesced refresh from the bundled core utilities. Cost dashboard reads time out after 30 seconds instead of blocking later refreshes, and refresh-failure warnings in both stay visible until a retry succeeds. Later and Sessions only rebuild against the updated shared core.
- 5dfbfa9: Reordering now works in legacy lists whose items share the same stored position.
- 7a9d63d: Completing or deleting an item in another client no longer makes pending edits, deletions, completions, or pastes of other items fail as "changed elsewhere".
- a6e153f: A Later dialog that is replaced or dismissed without answering no longer leaves `/later` and its actions disabled.
- 1ae9d93: Create new Cost and Later databases owner-only (0600 files in a 0700 directory) before SQLite writes to them, as Sessions already did; existing database permissions are left unchanged. All plugins now share one XDG state-path resolver.
- e70e939: Measure and truncate labels with the host renderer's width method in every plugin, so Cost project, model, and warning labels no longer overflow with wide characters such as CJK or emoji. Cost, Later, and Sessions keyboard hints with a matching command are now clickable, and all views take their colors from the shared theme palette.

## 0.2.0

### Minor Changes

- 805bb55: Publish independently versioned OpenCode V2 plugins with bundled private helpers and terminal extensions.

### Patch Changes

- 8f1a01b: Balance theme colors: use normal foreground for page/dialog titles and shortcut keys, muted labels and neutral borders, accent hues for sections/charts, and interactive hues for values. Preserve the theme's contrasting selection foreground/background pair.
- 572b6e9: Restore consistent theme-aware colors for headings, borders, metrics, keyboard hints, charts, and statuses. Follow live light/dark theme changes and preserve dialog and selection colors.
