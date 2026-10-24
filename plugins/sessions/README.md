# @lidtop/opencode-sessions

Find the conversation, not just the project. Search recorded OpenCode sessions across projects, including message text, and get back to the one you need.

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

Run `/sessions` or select **All sessions** in the command palette. `/sessions-all`, `/all-sessions`, and `/opcode-sessions` are aliases: names already used by other commands are left alone, and the first free name becomes the primary command. The palette entry works even if every name is taken.

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move selection |
| `/` | Edit the search: a case-insensitive JavaScript regular expression |
| `p` | Filter by project, including all of its indexed directories |
| `s` | Show or hide child sessions (hidden initially) |
| `enter` | Open the selected session |
| `x` | Clear the search and project filter; keep child visibility |
| `r` | Resynchronize changed sessions and message history |
| `esc` | Return to the screen that opened the browser |

Search matches titles, full directory paths, and complete indexed user and assistant messages, each separately, so anchors such as `^/home` apply to a whole field. Results are newest-updated first. Filters and matching apply **before** the newest 200 matches are kept; refine the search or project filter for older ones. Opening the browser resets its filters.

Expressions use Unicode mode when valid, otherwise legacy syntax, and are limited to 256 characters. Invalid expressions stay editable. Matching runs in a background worker with a three-second budget; when it expires, the matches found so far are shown, marked **partial**. The browser re-queries every five seconds while open.

On wide enough terminals, the preview shows the newest matching message centered on the match (up to 4,096 characters), the latest model, model count, indexed message count, recorded cost, and token counters. These are **indexed historical totals**, not current context use or billing totals.

Sessions in the current directory open directly. For another directory, after confirmation, the browser copies a shell-quoted `opencode '<directory>' --session '<id>'` command to the clipboard (OSC 52); nothing is launched. The quoting is for POSIX shells, not PowerShell or cmd. For a remote server, run the command with that server's paths and the **same server connection**; it does not include credentials or connection flags.

## Indexing

The server indexes each loaded location and follows session lifecycle, usage, content-update, and revert events, even without a terminal open.

- **Resilient refresh:** live subscriptions reconnect and reconcile immediately. A session that changes while being read is retried once idle, and individual failures retry up to three times without delaying other sessions. One busy or failing session never stops a refresh; deletions are still reconciled, and busy or failed counts are reported. Unchanged sessions are skipped, and overlapping refreshes are coalesced. Existing results stay searchable during slow resynchronization.
- **Full history:** server context holds only the active post-compaction window. To make earlier text searchable, the terminal fetches **full message history** in the background the first time the browser opens in each terminal process and on `r`, and uploads it in bounded, validated batches (at most 32 messages, 1 MiB of text per message, and 2 MiB per batch). Oversized messages are left out and counted, never truncated. Sessions that change or are deleted mid-upload are skipped and picked up by a later pass.
- **What's indexed:** only user and assistant text, not reasoning, tool inputs or results, attachments, or system and synthetic messages. Compaction never removes indexed text; reverts do. Deleted sessions and their descendants are removed and guarded against late writes, including after restarts. Forks sharing message IDs stay separate.

## Options

Set a custom database path on the **server**:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "@lidtop/opencode-sessions", "options": { "database": "/absolute/server/path/sessions.sqlite" } }
  ]
}
```

- `database`: where the index is stored. Relative paths resolve from the server's OpenCode state directory; the terminal ignores this option and uses RPC. `:memory:` is useful for tests, not durable history. The default is `$XDG_STATE_HOME/opencode/opencode-sessions-all/sessions.sqlite` (or `~/.local/state/opencode/opencode-sessions-all/sessions.sqlite`).

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

The build bundles the private `@opcode/core` and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external. The real-host RPC test needs an OpenCode binary on `PATH` or at `~/.opencode/bin/opencode`, and reports loudly when it is skipped.
