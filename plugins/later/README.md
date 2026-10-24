# @lidtop/opencode-later

Save the next idea without interrupting the current one. Keep a shared Later list across your local projects and sessions, visible in the sidebar, and paste an item into your prompt when it's time. Nothing runs automatically.

![Later list alongside an OpenCode session, keeping follow-up ideas visible in the sidebar](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/later-sidebar.png)

![Later manager with four active items, a selected follow-up, and completed history](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/later-manager.png)

## Install

Requires OpenCode **2.1.3 or newer in the 2.x line**.

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

**Where it runs.** The list is a SQLite file on the machine running the terminal. The terminal view reads and edits it; the server side only gives the agent [tools](#agent-tools) for the same file. An `opencode.json(c)` entry loads both sides, and OpenCode loads the terminal view automatically. To keep Later in the terminal only, without agent tools, put the entry in global `~/.config/opencode/cli.json` instead.

## Use

Run `/later` or select **Later** in the command palette. It opens a dialog with three tabs: **Later** (active items, in order), **History** (completed items, newest first), and **Settings**.

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | Switch tabs |
| `↑` / `↓`, `j` / `k` | Move selection |
| `enter` or `space` | Later: close the dialog, paste the item into the prompt, and complete it. History: restore the item |
| `a` | Add an item |
| `e` | Edit the selected item |
| `c` | Complete an active item, or restore a completed one |
| `d` | Delete permanently, after confirmation |
| `J` / `K` | Move an active item down / up |
| `/` | Search the tab's items |
| `r` | Refresh now |
| `esc` | Leave the search box, clear the search, then close |

**`enter` pastes an item into the prompt and marks it complete. It never submits the prompt or runs anything.** The text is inserted with normal paste behavior; existing prompt text is kept. Clicking an item does the same as `enter`.

Adding, editing, and deleting open OpenCode's own prompt in place of the dialog, which comes back on the same tab when you answer or cancel.

Duplicates are allowed. Items are trimmed and cannot be empty. Active numbers follow display order and are reassigned after removing or reordering. Restoring an item appends it to the active list. Nothing is captured from sessions automatically.

The sidebar lists the first active items, 5 by default, and "+N more in /later" for the rest; click it to open the dialog. Change the count in **Settings** (3, 5, 10, 15, or 20). The section is omitted when there are no active items; the plugin never forces the sidebar open. Changes from another local client or the agent's tools using the same database appear automatically, normally within 350 ms. Edits, deletes, and pastes of an item that changed elsewhere are rejected rather than applied to a newer version.

### Paste limitations

Paste-and-complete works only when `/later` was opened over home or a session. It closes the dialog, then waits up to one second for the prompt's paste command to be ready; if that times out, the destination changes, the plugin unloads, or the item changes while waiting, nothing is pasted or completed.

OpenCode V2 has no prompt-text setter or paste acknowledgement, so the item is marked complete after the paste is dispatched, not after anything runs. Review the prompt before submitting it yourself. This is not an exclusive task queue: two clients can still paste the same item.

## Agent tools

When the server side is loaded (an `opencode.json(c)` entry), the agent can manage the list when you ask, for example "add a Later item to bump the SDK" or "complete the Later item about docs":

| Tool | Does |
| --- | --- |
| `later_list` | Lists active items with their IDs, and completed ones on request |
| `later_add` | Adds an item to the end of the list |
| `later_complete` | Moves an active item to history |
| `later_delete` | Deletes an item permanently, **after you approve it** in OpenCode's permission prompt, which shows the item's text |

Adding and completing don't ask: a completed item can be restored from History. Deleting asks unless your permission rules already allow or deny `later_delete`. If the item changes while you decide, it is not deleted. Changes show up in an open `/later` dialog and the sidebar within a poll.

The tools edit the list on **the server's machine**. With a local server that is the terminal's own list. With a remote server they edit a separate list on that machine, not the one in your sidebar; load Later from `cli.json` alone there if that would be confusing.

## Options

```jsonc
// ~/.config/opencode/opencode.jsonc: the server side, for the agent's tools
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "@lidtop/opencode-later", "options": { "database": "/absolute/path/later.sqlite" } }
  ]
}
```

```jsonc
// ~/.config/opencode/cli.json: the terminal view
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    { "package": "@lidtop/opencode-later", "options": { "database": "/absolute/path/later.sqlite" } }
  ]
}
```

- `database`: where the list is stored. Relative paths resolve from `$XDG_STATE_HOME/opencode` (or `~/.local/state/opencode`) of the process that opens it, not the project directory. Paths are trimmed; `~` is not expanded. Different paths create different lists. The default is `$XDG_STATE_HOME/opencode/opencode-later/later.sqlite` (or `~/.local/state/opencode/opencode-later/later.sqlite`).

The terminal view loaded from an `opencode.json(c)` entry receives no options (OpenCode 2.1.3), so the default needs only that entry, but **a custom `database` needs both entries above, with the same path**: the server's for the tools, `cli.json`'s for the terminal. OpenCode then loads the terminal view once, from `cli.json`.

## Data and privacy

The database stores the item text you enter, IDs, positions, timestamps, and a revision counter. It collects no session or project metadata, but item text can contain anything you type. It also keeps the sidebar item count. It is not encrypted: protect its directory, file, WAL sidecars, and backups. Close all clients and OpenCode servers before moving or replacing it, and keep the WAL sidecars when backing up an open database. Later does not use OpenCode's own database or any server RPC; the agent's tools open the same file directly.

## Replacing opencode-later

The default database path and its `items` and `metadata` schema are the same as `opencode-later`'s, so IDs, order, timestamps, history, and the revision counter carry over without conversion. Remove the old entry and install this package instead; keep any custom `database` path and set it as in [Options](#options). Do not run both: they share `/later`, the sidebar, and the default database.

## Development

From the repository root:

```sh
mise exec -- bun test plugins/later/test
mise exec -- bun run typecheck
mise run dev later
```

The build bundles the private `@opcode/core`, `@opcode/tabs`, and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external.
