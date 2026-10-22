# @lidtop/opencode-later

Save the next idea without interrupting the current one. Keep a shared Later list across your local projects and sessions, visible in the sidebar, and paste an item into your prompt when it's time. Nothing runs automatically.

![Later list alongside an OpenCode session, keeping follow-up ideas visible in the sidebar](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/later-sidebar.png)

![Later manager with four active items, a selected follow-up, and completed history](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/later-manager.png)

## Install

Requires OpenCode **2.1.1 or newer in the 2.x line**.

```sh
opencode plugin add @lidtop/opencode-later
```

Or add it to `plugins` in your global `~/.config/opencode/opencode.jsonc` (or `opencode.json`), keeping your existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-later"]
}
```

**Where it runs.** Later is a terminal UI plugin; its server entrypoint does nothing. You can instead put the same entry in global `~/.config/opencode/cli.json` to load it on the client only, independent of server configuration. **Do not configure both.** The list is stored on the **terminal client's filesystem**, including when connected to a remote server, so clients on different machines do not share a list.

## Use

Run `/later` or select **Later** in the command palette.

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move selection |
| `a` | Add an item |
| `e` | Edit the selected active or completed item |
| `space` | Complete an active item, or restore a completed item |
| `enter` | Return to the originating prompt, paste the item, and complete it |
| `d` | Delete permanently, after confirmation |
| `J` / `K` | Move an active item down / up |
| `h` | Show or hide completed history |
| `r` | Refresh now |
| `esc` | Return to the originating screen |

**`enter` pastes an item into the prompt and marks it complete. It never submits the prompt or runs anything.** The text is inserted with normal paste behavior; existing prompt text is kept.

Duplicates are allowed. Items are trimmed and cannot be empty. Active numbers follow display order and are reassigned after removing or reordering. History is newest-completed first; restoring an item appends it to the active list. Nothing is captured from sessions automatically.

The sidebar is omitted when there are no active items; the plugin never forces it open. Changes from another local client using the same database appear automatically, normally within 350 ms. Edits, deletes, and pastes of an item that changed elsewhere are rejected rather than applied to a newer version.

### Paste limitations

Paste-and-complete works only when the manager was opened from home or a session. It waits up to one second for the destination prompt's paste command to be ready; if that times out, the destination changes, the plugin unloads, or the item changes while waiting, nothing is pasted or completed.

OpenCode V2 has no prompt-text setter or paste acknowledgement, so the item is marked complete after the paste is dispatched, not after anything runs. Review the prompt before submitting it yourself. This is not an exclusive task queue: two clients can still paste the same item.

## Options

Load the plugin in global `~/.config/opencode/cli.json` to pass options; server-loaded terminal extensions in OpenCode 2.1.1 do not reliably receive server plugin options.

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    { "package": "@lidtop/opencode-later", "options": { "database": "/absolute/path/later.sqlite" } }
  ]
}
```

- `database`: where the list is stored. Relative paths resolve from the client's `$XDG_STATE_HOME/opencode` (or `~/.local/state/opencode`), not the project directory. Paths are trimmed; `~` is not expanded. Different paths create different lists. The default is `$XDG_STATE_HOME/opencode/opencode-later/later.sqlite` (or `~/.local/state/opencode/opencode-later/later.sqlite`).

## Data and privacy

The database stores the item text you enter, IDs, positions, timestamps, and a revision counter. It collects no session or project metadata, but item text can contain anything you type. It is not encrypted: protect its directory, file, WAL sidecars, and backups. Close all clients before moving or replacing it, and keep the WAL sidecars when backing up an open database. Later does not use OpenCode's own database or any server RPC.

## Replacing opencode-later

The default database path and its `items` and `metadata` schema are the same as `opencode-later`'s, so IDs, order, timestamps, history, and the revision counter carry over without conversion. Remove the old entry and install this package instead; keep any custom `database` path and set it on the client side as in [Options](#options). Do not run both: they share `/later`, the sidebar, and the default database.

## Development

From the repository root:

```sh
mise exec -- bun test plugins/later/test
mise exec -- bun run typecheck
mise run dev later
```

The build bundles the private `@opcode/core` and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external.
