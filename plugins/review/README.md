# @lidtop/opencode-review

Review the agent's changes while it works. Diffs update as it edits, you leave comments on the lines, and the comments go to the agent with the file and lines attached, steering it before the turn is over.

## Install

Requires OpenCode **2.2.0 or newer in the 2.x line**.

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

**Where it runs.** The panel runs in the terminal. The server side records which comments a session was sent, gives its agent the `review_reply` tool, and runs the language servers and searches for usages, so configure the plugin where the server reads plugins (this config, or the remote server's). Diffs and usages come from the server, so they work against a remote server.

## Use

In a session, run `/diffs` or select **Review changes** in the command palette. The panel opens full screen in place of the conversation and takes the keyboard; `q` (or `esc`) goes back to the conversation. The changed files are listed as a folder tree (click a folder to fold it), `●` until you mark one viewed and `✓` after: beside the diff when the terminal is wide, and in a few rows above it when it's narrow. `b` hides or shows the list. `n` and `p` go through the files in the order the list shows them.

Move to a line, press `c`, type, and press `enter`. The comment is a **draft** until you send it with `S`, or press `esc`, which sends the drafts and closes the panel. All drafts go in one message, which steers the running agent: it reads them at its next step instead of waiting for the turn to end. Each comment shows its state:

- **draft:** not sent yet. `c` on it edits it, `x` deletes it.
- **sending**, then **waiting for the agent** while the message sits in the session's queue, then **sent**.
- **not confirmed:** the send failed partway. `S` sends it again under the same message ID, so the agent never gets it twice.

Cancelling the message from OpenCode's queue turns its comments back into drafts, as does a send the server refuses, such as one to a session that no longer exists. Sent comments can't be edited, since the agent already has them.

End a comment with `??` to ask the agent a question: it's told to answer it rather than change the code. For a question the agent doesn't need to see, ask about the lines instead (below).

The agent answers with `review_reply`, once per batch: **done** (it changed the code), **answered**, or **declined** (with why). Each reply shows under its comment. The tool only appears in sessions that have been sent review comments, so other sessions spend no context on it.

As the agent edits, drafts and the cursor follow the text they were on, and a draft's lines are updated to where that text is now. A comment whose lines are gone from the view is listed at the top as **Not in this diff any more**, with the lines it was on.

### Ask about the lines

Press `a` on a line (or on a range, after `v`), type a question, and press `enter`. The answer streams in under the line, from the model the conversation uses; switch the conversation's model and the next question follows it. The card names the model and shows **waiting**, **thinking...**, **answering...**, then **answered**. `x` on the line dismisses the answer, stopping it if it's still being written, and `esc` cancels the question still being answered before it closes the panel. `esc` in the question box leaves it unasked.

The question goes with the diff around its lines, and the model can read and search the repository to check callers and definitions before answering. It can't edit files, run commands, or ask you anything. Nothing reaches the agent.

The questions of a session, and its guided reviews, share a helper session of their own, made when first needed, so follow-ups keep their context: a question can ask about a slide of the guide. It's archived, so it stays out of OpenCode's session lists, and its usage and cost are recorded like any session's. The [Cost](../cost/README.md) plugin counts them, but not as agent time. Answers stay until you dismiss them or OpenCode exits.

### Guided review

Press `w` (or click **guide** in the panel's header) and the conversation's model presents the changes as a short slide deck, in a dialog over the panel. It reads the diff of the view you're on, and the repository where it needs to, and organizes the deck by idea rather than by file: an overview, then the core change, what builds on it, and a last slide on risks and what to check before merging. Each slide explains what the code does, why, and what deserves a careful look, with the changed lines it's about, from any files.

While the model writes, the dialog shows what it's doing as it goes: the files it reads, what it searches for, what it's thinking, and each slide's title as it's written. When it's done, the deck opens right there. `←` / `→` (or `h` / `l`, `n` / `p`, `space`) go between slides, `↑` / `↓` scroll a long one, and the dots at the bottom show where you are.

`esc` closes the dialog, leaving the guide as it is: if it's still being written, it keeps going, and the button reads **guide: writing...**. `w` opens it again, at the slide you were on, without asking the model again. `x` stops a guide still being written, and `r` asks for a new one, such as after the agent changed more. Excerpts follow their lines as the agent edits.

### What to review

Press `o` (or click **options** in the panel's header) for the options menu. It chooses the view:

- **This turn** (default): what changed since your last prompt. Steering comments are part of the same turn, so the view stays put while you steer.
- **Session:** everything the session changed since its first prompt.
- **Uncommitted:** the worktree against HEAD, including untracked files.
- **Branch:** the worktree against where it left a base branch. The base is found from the branch's history, or choose **Base branch...**.

The same menu switches the file list between the **Folder tree** and **Full paths**, a choice kept for every session.

The session views come from OpenCode's own snapshots and include edits you make yourself. Uncommitted and Branch show the whole worktree, so they include changes from other sessions in it.

**Agents in their own worktree.** An agent often makes a worktree and works there while its session stays where it started. Review follows the work: it reviews the worktree where the agent (or one of its subagents) last changed a file or ran a command, found from the paths its tools used, and the header names it, as in **Uncommitted in my-feature**. OpenCode's snapshots only cover the session's own directory, so there This turn and Session show the worktree's uncommitted changes instead; Branch works as usual. Usages, opened files, and questions go to that worktree too, and comments tell the agent which checkout their lines are from. **Worktree...** in the options picks one of the project's worktrees, or the session's own directory, for the session; **Where the agent works** goes back to following it. A session that moves to another directory is followed as well.

**Mark viewed** (`m`) sets a file aside and moves to the next one. A viewed file comes back as soon as its diff changes, so you see what the agent did since you last looked.

### Usages and definitions

Under the diff, the names on the cursor's line are listed with one picked: a name the line defines, else one that changed, else a call. Move between them with `h` and `l`. The picked name is drawn as selected in the code, and its other uses in the file are marked; the cursor's line has a stronger background of its own. Press `u` for its usages, or `d` for its definition.

Usages are grouped by file: the definition first, then the files the diff changes, then the rest. Each is marked `+` when it's on a changed line, `·` when it's elsewhere in a changed file, and blank when the diff doesn't touch it. The list says what the change may have missed:

- **signature changed**, and each use the diff didn't change is flagged **⚠ not updated?**: the agent changed the definition but maybe not every caller.
- **definition removed**, with the uses still left.
- **nothing uses it yet**, for a definition the diff adds that nothing calls.

`tab` shows all of them, only those in the diff, or only those outside it. `enter` opens one: on its diff row when the diff shows it, else in a read-only view of the file, where `c` comments as usual. Those comments reach the agent marked **(outside the diff)**, so it knows to touch a file it hasn't. In an opened usage, `n` and `p` go to the next and previous one. `esc` (or `ctrl+o`) goes back a step, to the list and then to the diff. A single definition opens directly.

**How they're found.** By default, the language server OpenCode is set up with for the file's language: your `lsp` config, merged across OpenCode's config files, or a built-in one (TypeScript, gopls, rust-analyzer, pyright, clangd, ruby-lsp, zls, lua-language-server, bash-language-server) when it's installed. `"lsp": false` turns them off. The server is started where the files are, kept running, and stopped after 10 idle minutes. It is asked about the exact symbol; right after it starts, the first lookup waits while it loads the project. Without a language server, or when it finds nothing, a whole-word search for the name answers instead (ripgrep, else `git grep`), and the list says why. **Search only** in the options never starts a language server. A name on a removed line is always searched for, since no file has that line any more.

### Keys

| Key | Action |
| --- | --- |
| `j` / `k`, `↓` / `↑` | Next / previous line |
| `ctrl+d` / `ctrl+u`, `pagedown` / `pageup` | Half a page down / up |
| `g` / `shift+g`, `home` / `end` | First / last line |
| `]` / `[` | Next / previous hunk |
| `shift+j` / `shift+k`, `alt+↓` / `alt+↑` | Next / previous file (clicking one in the list does too) |
| `n` / `p` | In a usage or search match you opened, the next / previous one |
| `/` | Search the diff: file paths and lines |
| `h` / `l`, `←` / `→` | Previous / next name on the line |
| `u` | Usages of the name |
| `d` | Definition of the name |
| `c`, `enter` | Comment on the line, or edit the draft there |
| `v` | Start a range, then `c` comments on it |
| `a` | Ask about the line or range, without the agent seeing it |
| `x` | Delete the draft on the line, or dismiss the answer there |
| `m` | Mark the file viewed, or not |
| `o` | Options: what to review, how files are listed, and how usages are found |
| `w` | Guided review: the changes as slides, by the conversation's model |
| `b` | Show or hide the file list |
| `r` | Refresh now |
| `S` | Send the drafts |
| `esc`, `ctrl+o` | Back from a usage or file; in the diff, `esc` cancels a question being answered, else sends the drafts and closes |
| `q` | Back to the conversation, keeping the drafts |
| `?` | Show or hide the key hints |
| `C` | All comments and the agent's replies |

### Search

`/` searches the diff as you type: the changed files whose path matches, those whose name matches first, then every diff line that does, removed lines included. It ignores case unless you type a capital letter. `↑` / `↓` move through the results while you type and `enter` opens one on its diff row; `esc` leaves the box with the results kept, where `j` / `k` move and `/` types again. In a match you opened, `n` / `p` go to the next and previous one, and `esc` comes back to the results.

In a usages list, `j` / `k` (or `n` / `p`) move, `enter` opens, `c` comments on the usage, `tab` changes the scope, `d` finds the definition, and `esc` goes back.

In the comment box, `enter` saves, `shift+enter` adds a line, and `esc` saves and closes the box. An empty comment is discarded. In a question box, `enter` asks and `esc` cancels.

### All comments

`C` (or **comments** in the header) lists every comment of the session, oldest first: its file and lines, whether it's a draft, waiting for the agent, or sent, its text, and the agent's reply in full. The header counts the comments and shows **● N new** when replies have come in since you last looked; opening the list marks them seen, and they stay marked **● new** while it's open. `j` / `k` move, `enter` opens a comment where it is (its diff row, or its file when the diff no longer shows it), `x` deletes a draft, `S` sends, and `esc` goes back.

## Storage

Comments and viewed files are kept in OpenCode's terminal storage, synced across terminals on the same machine and kept across restarts. The line you were on, a half-written comment, the answers to your questions, and the guided review, at the slide you were on, survive closing the panel, until OpenCode exits. Replies are kept in the server's plugin storage.
