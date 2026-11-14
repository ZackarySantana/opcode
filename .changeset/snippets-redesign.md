---
"@lidtop/opencode-snippets": minor
---

Snippets are saved from the chat you're in, or written in a built-in editor, instead of in a separate authoring chat.

- The agent in every session gets `snippet_list`, `snippet_read`, `snippet_write`, and `snippet_delete`, so you can ask it to save a handoff, change, rename, move, or delete a snippet where you are working. Every write and delete asks for approval: the plugin adds ask rules to each agent, after which an agent's own rules for those actions still win. `snippet_list` no longer returns every body; `snippet_read` returns one snippet's text and its expanded text. The plugin option `agentTools: false` removes the tools. `/snippets save [what]` starts such a request in the current session.
- `/snippets` in the terminal puts project and global snippets on separate tabs, with a scrollable preview of the outlined snippet beside the list: its text as written with references to other snippets in purple, file, flags, problems, and the snippets that use it. `e`, `n`, and `y` (duplicate) open an editor with name, scope, description, aliases, and multi-line text, where references turn purple as you type and `tab` or `↑`/`↓` move between fields; renaming or changing the scope moves the file. `d` names the snippets a delete would break. `c` copies a snippet to the clipboard to send someone, and `p` opens the editor filled in from a snippet on the clipboard. **Save Message as Snippet** in the command palette starts one from a message in the session.
- The desktop app gets a dialog with the list, the same preview, and the editor in one place, plus **Save Prompt as Snippet** and **Save Message as Snippet**. The separate edit and delete commands are gone.
- The authoring sessions, `/snippets new <request>`, and "edit in chat" are removed. `/snippets new` opens the editor.
- Snippet files edited by hand reach `@` completion as soon as they are saved.
