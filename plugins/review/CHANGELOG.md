# @lidtop/opencode-review

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
