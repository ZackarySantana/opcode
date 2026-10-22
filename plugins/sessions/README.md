# @lidtop/opencode-sessions

Search recorded OpenCode sessions across projects, including message text, from a shared terminal UI. Requires OpenCode **2.1.1 or newer within 2.x**, and its Bun runtime.

## Install

Configure once in your global `~/.config/opencode/opencode.jsonc` so opened projects also index sessions without a terminal browser:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-sessions"]
}
```

The package loads a server plugin and its `./tui` extension. It needs the server plugin: do not install only in `cli.json`. Use **All sessions** in the command palette or `/sessions`.

`/sessions-all`, `/all-sessions`, and `/opcode-sessions` are aliases. Names already occupied by active CLI or server commands are left alone; the first available name becomes the primary slash command. The palette command remains available if all names are occupied. Later-loaded command conflicts may require reloading the plugin.

## Browser

| Key | Action |
| --- | --- |
| `/` | Edit case-insensitive JavaScript regular expression |
| `p` | Filter project, including all of its indexed directories |
| `s` | Show/hide child sessions; hidden initially |
| `j` / `k`, arrows | Move selection; viewport follows |
| `enter` | Open selection |
| `x` | Clear search/project filters; retain child visibility |
| `r` | Resynchronize changed server records and message history |
| `escape` | Return to the route that opened the browser |

Search matches titles, full directory paths, and complete indexed user/assistant messages. Results are ordered by session update time, newest first, with stable ID ordering for ties. Visibility/project filters and regex matching apply **before** the newest 200 matching results are selected. Refine the query or project filter for older matches. Opening the browser resets its filters. Pending dialogs belong to that browser activation: leaving/reopening it or starting a newer dialog invalidates older results and clipboard confirmations.

Titles, directories, and each message are matched separately, so anchors such as `^/home` apply to a whole field. Expressions use Unicode mode when valid, otherwise legacy syntax. Invalid expressions remain editable. Expressions are limited to 256 characters (code points). Regex matching runs in a reused worker, outside the index write queue, with a 300 ms batch budget and a three-second scan budget. When either budget expires, the worker is terminated and the matches found so far are shown, marked **partial**, rather than blocking the server's JavaScript event loop. Large SQLite reads can still take time. The browser re-queries every five seconds while open; `r` performs the actual resynchronization.

Rows show a compact relative update time. Text fitting uses the shared UI's grapheme-aware terminal-cell helpers and the renderer's width method. On sufficiently wide/tall terminals, the preview shows the newest matching message as a window of up to 4,096 characters centered on the match, cut at grapheme boundaries, the latest recorded model, distinct-model count, indexed message count, recorded cost, and separate recorded token counters. These are **indexed historical totals**, not current context occupancy or guaranteed billing totals. No context-percentage claim is made.

Sessions in the current directory navigate directly. Another directory requires confirmation before copying a shell-quoted `opencode '<directory>' --session '<id>'` command using OSC52. Nothing is launched automatically. This is **POSIX-shell quoting**, not PowerShell/cmd syntax. Clipboard failure is reported. For a remote server, run the command in an environment with that server's paths and the **same server connection**; the copied command does not include server credentials or connection flags.

## Server-owned index and remote operation

SQLite is opened **only by the server**. The CLI searches its connected server's index over documented plugin RPC; it does not read a local SQLite file or require a shared filesystem. Historical imports use only pages fetched from that exact connected OpenCode client and sent back through its RPC subclient. No local conversation cache is read or uploaded to another server.

The server backfills each loaded location and indexes session lifecycle, usage, content-update, and revert events even without a CLI. Startup enumeration failures retry; live subscriptions reconnect, immediately reconcile the location even if the new stream is idle, and coalesce updates. Individual indexing failures retry up to three attempts on per-session timers, without delaying other sessions. A session that changes while it is read (for example, while streaming) is retried quietly and indexed once idle. Refresh enumerates server sessions with pagination, skips sessions whose indexed revision is current, and confirms missing records by ID, so moves do not become deletions. One busy or failing session never stops a refresh: the pass continues, deletions are still reconciled, and busy/failed counts are reported. Overlapping refreshes of one location share a pass, plus at most one follow-up. Host reads/page requests run outside the shared SQLite queue; existing indexed results remain searchable during slow background resynchronization. Session/batch commits use immediate SQLite transactions and retain revision and deletion guards. Deleted session families, including descendants indexed later, are removed and durably tombstoned against late writes, including after server restarts. A tombstone only guards against late writes: if a host read that started after the deletion returns the session (for example, after a transient not-found), it is indexed again.

Server context contains only the active post-compaction window. To make earlier text searchable, the CLI fetches **full historical message pages** in the background the first time the browser opens in each TUI process and on `r`, then uploads bounded, schema-validated batches. Launching a TUI does not synchronize by itself. The server records each session's imported history revision; unchanged sessions are skipped without fetching messages. Each short-lived token is tied to a server-verified session revision; changed/deleted sessions reject stale uploads. Such sessions are skipped and counted, and the pass continues; they are imported by a later pass. Batches allow at most 32 messages, 1 MiB of UTF-8 text per message, and 2 MiB serialized total. Oversized messages are left out and counted, never silently truncated; the rest of the session still imports. Connection or server failures stop the pass and are reported. Partial successfully imported history remains searchable.

Compaction alone never deletes earlier indexed text. Reverts do: message IDs ascend, and context always ends with the session's newest message, so on each context sync the server removes indexed messages newer than the newest context message. Compacted messages are older than the context window, so they stay. Reverting to before a compaction also removes the compacted messages after the revert point. Only user and assistant text is indexed: not reasoning, tool inputs/results, attachments, system/control messages, or synthetic messages. Forked histories sharing message IDs remain separate in the index.

## Database and legacy history

By default the **server** retains the old plugin's location:

```text
${XDG_STATE_HOME || ~/.local/state}/opencode/opencode-sessions-all/sessions.sqlite
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "@lidtop/opencode-sessions", "options": { "database": "/absolute/server/path/sessions.sqlite" } }
  ]
}
```

Relative paths resolve from the server's OpenCode state directory. The CLI ignores this filesystem option and uses RPC. `:memory:` is useful for tests, not durable history.

Existing `sessions`, `messages`, and `backfill` tables/data are retained. Older text-only indexes receive additive metric columns. Additional `opcode_sessions_*` tables provide sync revision, tombstone, and fork-message identity metadata. The redundant per-message revision table from earlier releases is dropped. There is no index deletion or destructive schema conversion. Back up SQLite safely before migration; **remove `opencode-sessions-all` from configuration** rather than running both writers against this file. The old completion-marker table is retained for compatibility, but not used to skip refreshes. Missing source sessions are reconciled away; an index is a cache, not a transcript backup.

## Privacy and access

**SQLite contains raw user and assistant text**, session titles, filesystem paths, model IDs, and usage metrics. Text may include secrets, pasted file contents, or sensitive material repeated by the model, even though tool payloads and attachments are excluded. The index is not encrypted.

New database files use mode `0600`; newly created index directories use `0700` on supported Unix filesystems. Existing directory/file permissions are not changed. Check permissions on legacy/custom files and SQLite WAL/SHM sidecars, especially shared folders and backups. All authenticated clients with access to the server/plugin RPC can search its index; this plugin adds no per-project authorization boundary. Protect the OpenCode server and its filesystem accordingly. The index enables SQLite `secure_delete`, so deleted text is overwritten in the database file, but this is not a secure-erasure guarantee for WAL frames, filesystem copies, or backups.

## Development

From the Opcode workspace:

```sh
mise exec -- bun test plugins/sessions/test
mise exec -- bun run typecheck
```

Tests cover actual domain/index behavior, matching/visibility before limits, partial results, centered previews, history pagination, upload bounds and skips, stale/deleted writes, concurrent SQLite writers, descendant tombstones and their clearing, revert pruning, disk tombstones and permissions, offline deletion/move reconciliation, partial refresh failures, refresh and event coalescing, nonblocking resynchronization, cancellation/idle reconnect, dialog activation ownership, setup-level connection pinning, and compiled OpenTUI rendering with distinct selected preview values through reorder/shrink/resize. The real-host RPC test needs an OpenCode binary on `PATH` or at `~/.opencode/bin/opencode`, and reports loudly when it is skipped. The package uses documented V2 APIs and the installed workspace API versions; no host-tree introspection or V1 runtime layer is used.
