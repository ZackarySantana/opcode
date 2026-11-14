# @lidtop/opencode-snippets

## 0.3.0

### Minor Changes

- 06b3990: Snippets can use other snippets: `@name` on its own in a snippet's body is replaced by that snippet's current text when it is sent, through nested references. A reference to no snippet, a loop, or an expansion past 64 KiB stays as typed, and `/snippets` and the desktop list mark such a snippet **broken reference**. Writing a snippet in chat rejects those references before asking for approval, and deleting one names the snippets that used it.
- 9c2b277: Snippets are saved from the chat you're in, or written in a built-in editor, instead of in a separate authoring chat.

  - The agent in every session gets `snippet_list`, `snippet_read`, `snippet_write`, and `snippet_delete`, so you can ask it to save a handoff, change, rename, move, or delete a snippet where you are working. Every write and delete asks for approval: the plugin adds ask rules to each agent, after which an agent's own rules for those actions still win. `snippet_list` no longer returns every body; `snippet_read` returns one snippet's text and its expanded text. The plugin option `agentTools: false` removes the tools. `/snippets save [what]` starts such a request in the current session.
  - `/snippets` in the terminal puts project and global snippets on separate tabs, with a scrollable preview of the outlined snippet beside the list: its text as written with references to other snippets in purple, file, flags, problems, and the snippets that use it. `e`, `n`, and `y` (duplicate) open an editor with name, scope, description, aliases, and multi-line text, where references turn purple as you type and `tab` or `↑`/`↓` move between fields; renaming or changing the scope moves the file. `d` names the snippets a delete would break. `c` copies a snippet to the clipboard to send someone, and `p` opens the editor filled in from a snippet on the clipboard. **Save Message as Snippet** in the command palette starts one from a message in the session.
  - The desktop app gets a dialog with the list, the same preview, and the editor in one place, plus **Save Prompt as Snippet** and **Save Message as Snippet**. The separate edit and delete commands are gone.
  - The authoring sessions, `/snippets new <request>`, and "edit in chat" are removed. `/snippets new` opens the editor.
  - Snippet files edited by hand reach `@` completion as soon as they are saved.

### Patch Changes

- b4b8592: Bundles the updated shared core, which adds the side-session metadata tag that Review and Cost use. No change in behavior.
- 3d6079d: Sessions no longer has the Agents sidebar section, and with it `/go`, `/back`, `/previous`, **Go to active session**, **Go back**, the alerts for new requests and finished runs, the `opcode-sessions.navigate` command, and the `inbox` options. Sessions is now the `/sessions` search browser alone. Snippets opens its authoring sessions directly.
- 2540a17: Rebuilt with the shared dialog components, whose Settings tab now draws its choices with a component GH PR Status also uses. Nothing visible changes.

## 0.2.0

### Minor Changes

- 62c9603: Require OpenCode 2.2.0 and OpenTUI 0.7.
- 99c0094: Add an OpenCode Desktop part: `/snippets` lists snippets to insert `@name` into the prompt or write a new one in a chat, and the command palette offers editing a snippet in chat and deleting one.

## 0.1.2

### Patch Changes

- 5ccffe8: Shared code moved into helpers every plugin bundles: the refresh schedule now also works outside the terminal, and there are new helpers for state shared by a server's projects, RPC contracts and handlers, and following a server's state. For Context, Feed, Later, and Media nothing changes. In Cost, Review, Snippets, and Sessions, a call the terminal aborted is no longer reported as a failure. In Sessions, every project open on a server now shares one search index connection and one writer per database file, rather than possibly one per project.
- e91635a: Shared code that Feed and GH PR Status use moved into helpers every plugin bundles: the minute clock that ages views, and sending changes to the server in order while showing them at once. Nothing changes for any plugin.

## 0.1.1

### Patch Changes

- 668e220: Snippet files saved with a byte order mark, or with `aliases:` items written as unindented `- item` lines, keep their description and aliases. `snippet_delete` reports a missing snippet, an alias, or the wrong scope before asking for approval, and `snippet_write` rejects aliases that would insert another snippet (a name always wins over an alias) before asking, naming the snippet each one inserts. A project snippet's alias may still take over a global snippet's alias. An alias two snippets of the same scope share now goes to the first by name.

## 0.1.0

### Minor Changes

- 1708674: Add Snippets: reusable prompt text inserted with `@name`, managed in `/snippets`, and written in chat sessions where every write asks for approval. `@name` typed or pasted without completion attaches the snippet too. `/snippets` opens as a dialog over the current screen: `enter` closes it and inserts `@name ` into the prompt, and `/` searches names, aliases, descriptions, and text. With the Sessions plugin loaded, authoring sessions open through it, so its sidebar offers a way back to the session you came from.
