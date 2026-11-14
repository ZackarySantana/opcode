# @lidtop/opencode-review

## 0.3.0

### Minor Changes

- b4b8592: The panel always opens full screen, in place of the conversation, so it looks the same on every terminal; `f` is gone, and `q` goes back to the conversation. New: press `a` on a line or range to ask about it, answered by the conversation's model without the agent seeing it. The answer streams in under the line, `x` dismisses it, and `esc` cancels one still being answered. Questions run in an archived session of their own, made on the first one: it can only read and search the repository, and its usage is recorded like any session's.
- 1624f92: New: a guided review. Press `w` (or click **guide** in the panel's header) and the conversation's model presents the changes as a short slide deck, in a dialog: organized by idea rather than by file, each slide explaining what the code does and what to look at, with the changed lines it's about. While it writes, the dialog streams what the model is doing, then the deck opens there. `←` / `→` move between slides; closing keeps the guide, and `w` opens it again at the same slide. Guides and questions share one helper session per reviewed session, so a question can ask about a slide.
- 22daac6: The panel's slash command is now `/diffs`. OpenCode's built-in `/review` command (a code-review prompt) took precedence over the plugin's, so `/review` sent that prompt instead of opening the panel. **Review changes** in the command palette is unchanged.
- b4b8592: Review follows an agent into its worktree. When the agent changes files or runs commands in a worktree other than its session's directory, Review reviews that worktree, as Uncommitted (OpenCode's snapshots don't cover it), and names it in the header. Usages, opened files, and questions go there too. **Worktree...** in the options picks a checkout for the session, and the diff now reloads when a session moves.

## 0.2.0

### Minor Changes

- 62c9603: Require OpenCode 2.2.0 and OpenTUI 0.7.

## 0.1.2

### Patch Changes

- 5ccffe8: Shared code moved into helpers every plugin bundles: the refresh schedule now also works outside the terminal, and there are new helpers for state shared by a server's projects, RPC contracts and handlers, and following a server's state. For Context, Feed, Later, and Media nothing changes. In Cost, Review, Snippets, and Sessions, a call the terminal aborted is no longer reported as a failure. In Sessions, every project open on a server now shares one search index connection and one writer per database file, rather than possibly one per project.
- e91635a: Shared code that Feed and GH PR Status use moved into helpers every plugin bundles: the minute clock that ages views, and sending changes to the server in order while showing them at once. Nothing changes for any plugin.

## 0.1.1

### Patch Changes

- 6930cad: List Review under diff, language server, and agent searches on npm.

## 0.1.0

### Minor Changes

- 5f25f3b: Add Review: `/review` opens the agent's changes in a panel beside the conversation, updating as it edits. Comment on a line or range, then send the drafts with `S` (or `esc`, which also closes the panel); they reach the running agent at its next step, with the file and lines attached. The agent replies to each with `review_reply`, shown under your comment and in the list of every comment (`C`), which marks replies that are new, and a comment ending in `??` asks a question instead of a change. `u` and `d` find the usages and the definition of the name under the cursor, by the language server OpenCode is set up with or a search by name, and flag uses the change may have missed; open one to comment on it, even outside the diff. `/` searches the paths and lines of the diff. The options menu (`o`) picks what to review (this turn, the whole session, uncommitted changes, or the branch against its base) and lists files as a folder tree or full paths; files stay marked viewed until their diff changes.
