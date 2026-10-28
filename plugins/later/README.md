# @lidtop/opencode-later

Save the next idea without interrupting the current one. Keep one Later list across your projects, sessions, and terminals, visible in the sidebar, and paste an item into your prompt when it's time. Nothing runs automatically.

[![Watch the Later demo: an idea saved for later by the agent, then reordered and pasted back into the prompt](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/later-demo.jpg)](https://github.com/user-attachments/assets/6c145b7c-be82-4ebe-a735-9e40ba2706d9)

*The 36-second demo uses sample data.*

![Later list alongside an OpenCode session, keeping follow-up ideas visible in the sidebar](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/later-sidebar.png)

![Later manager with four active items, a selected follow-up, and completed history](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/later-manager.png)

## Install

Requires OpenCode **2.2.0 or newer in the 2.x line**.

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

**Where it runs.** The server side keeps the list and its settings in the OpenCode server's plugin storage and gives the agent its [tools](#agent-tools); the sidebar and `/later` in the terminal show and change that list over plugin RPC (both parts use the ID `opcode-later`). Configure it where the server reads plugins (this config, or the remote server's), not in `cli.json`: a terminal-only install has no server side to ask, and `/later` says to add it to the server's plugins.

**One list.** Every terminal connected to the same server, and the agent in every project, shares one list and its settings. A change anywhere shows in every open sidebar and `/later` dialog right away.

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

The sidebar lists the first active items, 5 by default, and "+N more in /later" for the rest; click it to open the dialog. Change the count in **Settings** (3, 5, 10, 15, or 20). The section is omitted when there are no active items; the plugin never forces the sidebar open. Changes from another terminal or the agent's tools appear automatically. Edits, completions, deletes, and pastes of an item that changed elsewhere are rejected rather than applied to a newer version. While the server can't read the stored list, `/later` says so and changes are refused, rather than starting an empty list over it; it tries again on its own.

### Paste limitations

Paste-and-complete works only when `/later` was opened over home or a session. It closes the dialog, then waits up to one second for the prompt's paste command to be ready; if that times out, the destination changes, the plugin unloads, or the item changes while waiting, nothing is pasted or completed.

OpenCode V2 has no prompt-text setter or paste acknowledgement, so the item is marked complete after the paste is dispatched, not after anything runs. Review the prompt before submitting it yourself. This is not an exclusive task queue: two clients can still paste the same item.

## Agent tools

When the server side is loaded (an `opencode.json(c)` entry), the agent can manage the list when you ask, for example "add a Later item to bump the SDK" or "complete the Later item about docs":

| Tool | Does |
| --- | --- |
| `later_list` | Lists active items with their IDs, and completed ones on request |
| `later_add` | Adds an item to the end of the list |
| `later_edit` | Replaces an item's text, moves an active item to history, or restores a completed one to the end of the list |
| `later_delete` | Deletes an item permanently, **after you approve it** in OpenCode's permission prompt, which shows the item's text |

Adding and editing don't ask: an edit's result in the transcript includes the previous text, and a completed item can be restored. Deleting asks unless your permission rules already allow or deny `later_delete`. If the item changes while you decide, it is not deleted. Changes show up in an open `/later` dialog and the sidebar right away.

To stop the agent using them, set **Agent tools** to off in `/later` **Settings**. Sessions created after that don't get the tools. Older sessions keep them listed, so their requests stay the same and keep hitting the provider's prompt cache, but every call is refused. Turning the tools back on asks first: it adds them to every open session's request, so each one's next message misses the prompt cache once. The setting is shared by every terminal on the server and applies from the next request, without a restart.

## Data and privacy

The server's plugin storage keeps the item text you enter, IDs, order, timestamps, a revision counter, the sidebar item count, and, while agent tools are off, when they were turned off. It collects no session or project metadata, but item text can contain anything you type, and it is sent to the terminals connected to the server. Nothing else is sent anywhere.

Earlier versions kept the list in `opencode-later/later.sqlite` in the terminal's OpenCode state directory (`$XDG_STATE_HOME/opencode`, or `~/.local/state/opencode`), or a custom `database` path. That list is not carried over: re-add the items you want to keep, then you can delete the file. The `database` option is gone.

## Replacing opencode-later

Its SQLite list is not imported, as above. Remove the old entry and install this package instead. Do not run both: they share `/later` and the sidebar.

## Development

From the repository root:

```sh
mise exec -- bun test plugins/later/test
mise exec -- bun run typecheck
mise run dev later
```

The build bundles the private `@opcode/core`, `@opcode/tabs`, and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external.
