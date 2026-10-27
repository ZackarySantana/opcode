# @lidtop/opencode-review

Review the agent's changes while it works. Diffs update as it edits, you leave comments on the lines, and the comments go to the agent with the file and lines attached, steering it before the turn is over.

## Install

Requires OpenCode **2.1.3 or newer in the 2.x line**.

```sh
opencode plugin add @lidtop/opencode-review
```

Or add it to `plugins` in your global `~/.config/opencode/opencode.jsonc` (or `opencode.json`), keeping your existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-review"]
}
```

**Where it runs.** The panel runs in the terminal. The server side records which comments a session was sent and gives its agent the `review_reply` tool, so configure the plugin where the server reads plugins (this config, or the remote server's). Diffs come from the server too, so they work against a remote server.

## Use

In a session, run `/review` or select **Review changes** in the command palette. The panel opens beside the conversation and takes the keyboard; `f` makes it full screen. On a wide panel the changed files are listed on the left, `●` until you mark one viewed and `✓` after.

Move to a line, press `c`, type, and press `enter`. The comment is a **draft** until you send it with `S`, or press `esc`, which sends the drafts and closes the panel. All drafts go in one message, which steers the running agent: it reads them at its next step instead of waiting for the turn to end. Each comment shows its state:

- **draft:** not sent yet. `c` on it edits it, `x` deletes it.
- **sending**, then **waiting for the agent** while the message sits in the session's queue, then **sent**.
- **not confirmed:** the send failed partway. `S` sends it again under the same message ID, so the agent never gets it twice. The sidebar counts these as left to send.

Cancelling the message from OpenCode's queue turns its comments back into drafts, as does a send the server refuses, such as one to a session that no longer exists. Sent comments can't be edited, since the agent already has them.

End a comment with `??` to ask a question: the agent is told to answer it rather than change the code.

The agent answers with `review_reply`, once per batch: **done** (it changed the code), **answered**, or **declined** (with why). Each reply shows under its comment. The tool only appears in sessions that have been sent review comments, so other sessions spend no context on it.

As the agent edits, drafts and the cursor follow the text they were on, and a draft's lines are updated to where that text is now. A comment whose lines are gone from the view is listed at the top as **Not in this diff any more**, with the lines it was on.

### What to review

Press `d` to choose:

- **This turn** (default): what changed since your last prompt. Steering comments are part of the same turn, so the view stays put while you steer.
- **Session:** everything the session changed since its first prompt.
- **Uncommitted:** the worktree against HEAD, including untracked files.
- **Branch:** the worktree against where it left a base branch. The base is found from the branch's history, or choose **Base branch...**.

The session views come from OpenCode's own snapshots and include edits you make yourself. Uncommitted and Branch show the whole worktree, so they include changes from other sessions in it.

**Mark viewed** (`m`) sets a file aside and moves to the next one. A viewed file comes back as soon as its diff changes, so you see what the agent did since you last looked.

### Keys

| Key | Action |
| --- | --- |
| `j` / `k`, `↓` / `↑` | Next / previous line |
| `ctrl+d` / `ctrl+u`, `pagedown` / `pageup` | Half a page down / up |
| `g` / `shift+g`, `home` / `end` | First / last line |
| `]` / `[` | Next / previous hunk |
| `n` / `p`, `alt+↓` / `alt+↑` | Next / previous file (clicking one in the list does too) |
| `c`, `enter` | Comment on the line, or edit the draft there |
| `v` | Start a range, then `c` comments on it |
| `x` | Delete the draft on the line |
| `m` | Mark the file viewed, or not |
| `d` | Choose what to review |
| `b` | Show or hide the file list |
| `f` | Full screen |
| `r` | Refresh now |
| `S` | Send the drafts |
| `esc` | Send the drafts and close |
| `q` | Close, keeping the drafts |

In the comment box, `enter` saves, `shift+enter` adds a line, and `esc` saves and closes the box. An empty comment is discarded.

The sidebar shows the session's review once it has comments: how many are left to send, waiting for the agent, and replied to. Click it to open the panel.

## Storage

Comments and viewed files are kept in OpenCode's terminal storage, synced across terminals on the same machine and kept across restarts. The line you were on and a half-written comment survive closing the panel, until OpenCode exits. Replies are kept in the server's plugin storage.
