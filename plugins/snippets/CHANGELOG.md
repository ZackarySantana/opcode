# @lidtop/opencode-snippets

## 0.1.1

### Patch Changes

- 668e220: Snippet files saved with a byte order mark, or with `aliases:` items written as unindented `- item` lines, keep their description and aliases. `snippet_delete` reports a missing snippet, an alias, or the wrong scope before asking for approval, and `snippet_write` rejects aliases that would insert another snippet (a name always wins over an alias) before asking, naming the snippet each one inserts. A project snippet's alias may still take over a global snippet's alias. An alias two snippets of the same scope share now goes to the first by name.

## 0.1.0

### Minor Changes

- 1708674: Add Snippets: reusable prompt text inserted with `@name`, managed in `/snippets`, and written in chat sessions where every write asks for approval. `@name` typed or pasted without completion attaches the snippet too. `/snippets` opens as a dialog over the current screen: `enter` closes it and inserts `@name ` into the prompt, and `/` searches names, aliases, descriptions, and text. With the Sessions plugin loaded, authoring sessions open through it, so its sidebar offers a way back to the session you came from.
