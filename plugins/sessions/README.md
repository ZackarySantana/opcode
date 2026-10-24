# @lidtop/opencode-sessions

Find the conversation, not just the project. Search recorded OpenCode sessions across projects, including message text, and get back to the one you need. The sidebar keeps every active agent in view, across projects.

![Sessions browser searching for cache discussions across projects with a selected message preview](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/sessions-browser.png)

## Install

Requires OpenCode **2.1.3 or newer in the 2.x line**.

```sh
opencode plugin add @lidtop/opencode-sessions
```

Or add it to `plugins` in your global `~/.config/opencode/opencode.jsonc` (or `opencode.json`), keeping your existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-sessions"]
}
```

**Where it runs.** Install it globally so opened projects keep their index up to date even without the browser open. The server builds and owns the index; the terminal browser searches it over plugin RPC. A client-only install in `cli.json` does not work, because the browser needs the server plugin.

## Use

Run `/sessions` or select **All sessions** in the command palette to open the browser dialog. `/sessions-all` and `/all-sessions` are aliases: names already used by other commands are left alone, and the first free name becomes the primary command. The palette entry works even if every name is taken.

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move selection |
| `/` | Type in the search box: a case-insensitive JavaScript regular expression, applied as you type |
| `p` | Filter by project, including all of its indexed directories; clears the search |
| `s` | Show or hide child sessions (hidden initially) |
| `enter` | Close the dialog and open the selected session |
| `x` | Clear the search and project filter; keep child visibility |
| `r` | Resynchronize changed sessions and message history |
| `esc` | Undo one step: stop typing, clear the search, drop the project filter, then close |

Search matches titles, full directory paths, and complete indexed user and assistant messages, each separately, so anchors such as `^/home` apply to a whole field. Results are newest-updated first. Filters and matching apply **before** the newest 200 matches are kept; refine the search or project filter for older ones. Opening the browser resets its filters.

Expressions use Unicode mode when valid, otherwise legacy syntax, and are limited to 256 characters. Invalid expressions stay editable. Matching runs in a background worker with a three-second budget; when it expires, the matches found so far are shown, marked **partial**. The browser re-queries every five seconds while open.

When the dialog is wide enough, the preview shows the newest matching message centered on the match (up to 4,096 characters), the latest model, model count, indexed message count, recorded cost, and token counters. These are **indexed historical totals**, not current context use or billing totals.

`enter` opens the session in this terminal, whichever directory it belongs to.

## Active sessions

The **Agents** section at the top of the sidebar lists root sessions from every project and location that need attention, numbered in the order they became active. The order doesn't change as their states do:

| Mark | State | When |
| --- | --- | --- |
| `●` | needs you | A permission or question is waiting anywhere in the session or its subagents, or a retry needs you to act |
| `✗` | failed | The run failed, and you haven't opened the session since |
| `✓` | finished | The run finished, and you haven't opened the session since |
| `↻` | retrying | The session or a subagent is retrying after an error |
| `○` | working | The session or a subagent is running |

Subagents are rolled up into their root session ("2 agents"); only the root needs to be seen for a finished run to drop out, and archived sessions never appear. The session you are in isn't listed. Each row shows its project, the time since it finished or was last active, and its title. Five rows are shown; "+N more" opens the full list.

- Click a row, or run `/go <n>`, to open session n. `/go` alone, or **Go to active session** in the command palette, lists them all.
- After the plugin takes you somewhere (a sidebar click, `/go`, the list, or opening a session from `/sessions`), a **Back to …** row appears above the list; click it, or run `/back`, `/previous`, or `/go back`. Going back again retraces each step. Switching sessions any other way, such as with tabs or going home, forgets the trail.
- `/go`, `/back`, and `/previous` are each skipped when another command already uses that name; the palette entries (**Go to active session**, **Go back**) always work.

The list follows the connected server's live events and is rebuilt on every (re)connection; nothing is stored. A finished session outside the newest 100 root sessions appears only once it becomes active again.

### From other plugins

To open a session so that **Back to …** returns to where the user was, dispatch `opcode-sessions.navigate` with the session ID instead of navigating directly:

```ts
api.keymap.dispatch("opcode-sessions.navigate", sessionID)
```

It works from any input mode, including over a dialog, but only navigates: close your own dialog first (`api.ui.dialog.clear()`). With `inbox.enabled: false` it still navigates, without a back trail.

## Indexing

The server indexes each loaded location and follows session lifecycle, usage, content-update, and revert events, even without a terminal open.

- **Resilient refresh:** live subscriptions reconnect and reconcile immediately. A session that changes while being read is retried once idle, and individual failures retry up to three times without delaying other sessions. One busy or failing session never stops a refresh; deletions are still reconciled, and busy or failed counts are reported. Unchanged sessions are skipped, and overlapping refreshes are coalesced. Existing results stay searchable during slow resynchronization.
- **Full history:** server context holds only the active post-compaction window. To make earlier text searchable, the terminal fetches **full message history** in the background the first time the browser opens in each terminal process and on `r`, and uploads it in bounded, validated batches (at most 32 messages, 1 MiB of text per message, and 2 MiB per batch). Oversized messages are left out and counted, never truncated. Sessions that change or are deleted mid-upload are skipped and picked up by a later pass.
- **What's indexed:** only user and assistant text, not reasoning, tool inputs or results, attachments, or system and synthetic messages. Compaction never removes indexed text; reverts do. Deleted sessions and their descendants are removed and guarded against late writes, including after restarts. Forks sharing message IDs stay separate.

## Options

Set a custom database path on the **server** (`opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "@lidtop/opencode-sessions", "options": { "database": "/absolute/server/path/sessions.sqlite" } }
  ]
}
```

- `database`: where the index is stored. Relative paths resolve from the server's OpenCode state directory; the terminal ignores this option and uses RPC. `:memory:` is useful for tests, not durable history. The default is `$XDG_STATE_HOME/opencode/opencode-sessions-all/sessions.sqlite` (or `~/.local/state/opencode/opencode-sessions-all/sessions.sqlite`).

Configure the active-sessions sidebar on the **terminal**: terminal extensions receive options only from global `~/.config/opencode/cli.json`. Keep the server entry too; the terminal loads the plugin once, with these options.

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    { "package": "@lidtop/opencode-sessions", "options": { "inbox": { "rows": 8, "notify": true } } }
  ]
}
```

- `inbox.enabled` (default `true`): `false` removes the sidebar section and its commands (`/go`, `/back`, `/previous`), and stops listening for session events.
- `inbox.rows` (default `5`): rows shown before "+N more".
- `inbox.notify` (default `false`): a desktop notification and sound while the terminal is unfocused, plus a toast, for each new permission or question and each finished or failed run, except in the session family you are in. They follow your OpenCode attention settings.

## Data and privacy

**The database contains raw user and assistant text**, session titles, filesystem paths, model IDs, and usage metrics. Text can include secrets, pasted file contents, or sensitive material repeated by the model, even though tool payloads and attachments are excluded. The index is not encrypted, and it is a cache, not a transcript backup.

**Only the server opens SQLite.** New database files use `0600` and new directories `0700` on Unix filesystems; existing permissions are not changed, so check legacy or custom files and their WAL/SHM sidecars. Every authenticated client of the server can search its index; there is no per-project access boundary. SQLite `secure_delete` overwrites deleted text in the database file, but this is not secure erasure of WAL frames, copies, or backups.

## Replacing opencode-sessions-all

The default database path is the same as `opencode-sessions-all`'s, and its `sessions`, `messages`, and `backfill` tables are kept; older indexes gain additive columns and `opcode_sessions_*` tables, with no destructive conversion, so older processes sharing the file keep working. Back up the database first, then **remove `opencode-sessions-all`** rather than running both writers against the same file.

## Development

From the repository root:

```sh
mise exec -- bun test plugins/sessions/test
mise exec -- bun run typecheck
mise run dev sessions
```

The build bundles the private `@opcode/core`, `@opcode/tabs`, and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external. The real-host RPC test needs an OpenCode binary on `PATH` or at `~/.opencode/bin/opencode`, and reports loudly when it is skipped.
