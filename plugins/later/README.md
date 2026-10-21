# @lidtop/opencode-later

A client-local, persistent Later list for the OpenCode V2 terminal UI. `/later` manages active items and completed history; active items also appear in the session sidebar when it is visible.

**Enter pastes an item into the originating prompt and marks it complete. It never submits the prompt or executes work.** Text is inserted using normal paste behavior; existing prompt text is not cleared.

## Install

Requires OpenCode **2.1.1 or newer in the 2.x line**, with its Bun terminal plugin runtime. Add the package to your global `~/.config/opencode/opencode.jsonc`, preserving existing settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-later"]
}
```

The main entrypoint is inert. OpenCode automatically loads its `./tui` extension. Alternatively, put the same plugin entry in global `~/.config/opencode/cli.json` for client-only loading independent of server configuration. **Do not configure both.** Restart the terminal client if necessary.

The database is always on the **terminal client's filesystem**, including when connected to a remote OpenCode server. Clients on different machines do not share a list automatically. This is a terminal UI plugin, not a desktop, Mini, or headless task runner.

## Use

Run `/later` or select **Later** in the command palette.

| Key | Action |
| --- | --- |
| `a` | Add an item |
| `e` | Edit the selected active or completed item |
| `space` | Complete an active item, or restore a completed item |
| `enter` | Return to the originating home/session prompt, paste, and complete |
| `d` | Permanently delete after confirmation |
| `J` / `K` | Move an active item down/up |
| `j` / `k`, arrows | Move selection |
| `h` | Show/hide completed history |
| `r` | Refresh immediately |
| `esc` | Return to the originating screen |

Duplicates are allowed. Messages are trimmed and cannot be empty. Active numbers follow display order and are reassigned after removal/reordering. History is newest-completed first; restoring appends to the active list. Nothing is automatically captured from sessions.

The sidebar is omitted when there are no active items; the plugin never forces it open. Changes made by another local client using the same database refresh automatically, normally within 350 ms. Selection is reconciled when items disappear. Stale edit/delete/paste operations are rejected rather than silently changing a different or newer item.

### Paste limitations

Paste-and-complete is available only when the manager was opened from home or a session. It waits up to one second for a destination frame with the documented prompt-paste command reachable and enabled; it does not wait for animations or other live rendering to stop. Disposal cancels the wait and removes its listeners/timer. If readiness times out, the destination changes, the plugin unloads, or the item changes while waiting, nothing is pasted or completed.

OpenCode V2 currently exposes no prompt-text setter or paste-delivery acknowledgement. The isolated bridge uses the public OpenTUI paste pipeline and marks the item complete after dispatch, not after model execution. Review the prompt before submitting it yourself. This is not an exclusive multi-client task-claiming queue; simultaneous clients can still paste the same item.

## Storage and compatibility

The default remains the legacy `opencode-later` database:

```text
$XDG_STATE_HOME/opencode/opencode-later/later.sqlite
# or, when XDG_STATE_HOME is unset:
~/.local/state/opencode/opencode-later/later.sqlite
```

The existing `items` and `metadata` SQLite schema is unchanged. IDs, active order, timestamps, completed history, and the revision counter are retained without conversion. WAL and transactions support multiple local clients. The plugin does not use OpenCode's own database or server RPC.

To replace `opencode-later`, remove its configuration entry and install `@lidtop/opencode-later` instead. Keep any custom `database` path unchanged and configure it on the CLI side as below. Do not run both UI plugins together: they share `/later`, sidebar content, and the default database.

### Custom database

For a custom client-local path, load Later in global `~/.config/opencode/cli.json`
instead of separately configuring it on the server. Server-loaded TUI extensions
in OpenCode 2.1.1 do not reliably receive server plugin options.

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "@lidtop/opencode-later",
      "options": { "database": "/absolute/path/later.sqlite" }
    }
  ]
}
```

Relative paths resolve from the client's `$XDG_STATE_HOME/opencode` (or `~/.local/state/opencode`), **not the project directory**. Paths are trimmed; `~` is not expanded. Omitting the option uses the legacy default. Different paths intentionally create different lists.

The database stores user-entered item text, IDs, positions, timestamps, and a revision counter; it does not collect session/project metadata or extract credentials. Item text can still contain secrets you enter. The database is not encrypted: protect its directory, file, WAL sidecars, and backups with appropriate permissions. Back it up before manual maintenance; close all clients before moving or replacing it, and preserve SQLite WAL sidecars when backing up an open database.

## Development

From the monorepo root:

```sh
mise exec -- bun test plugins/later/test
mise exec -- bun run typecheck
```

The root build compiles `src/index.ts` and `src/tui.tsx`, bundling the private `@opcode/core` and `@opcode/ui` workspaces while keeping OpenCode, OpenTUI, and Solid external.
