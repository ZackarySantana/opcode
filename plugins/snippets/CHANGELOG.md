# @lidtop/opencode-snippets

## 0.1.0

### Minor Changes

- 1708674: Add Snippets: reusable prompt text inserted with `@name`, managed in `/snippets`, and written in chat sessions where every write asks for approval. `@name` typed or pasted without completion attaches the snippet too. `/snippets` opens as a dialog over the current screen: `enter` closes it and inserts `@name ` into the prompt, and `/` searches names, aliases, descriptions, and text. With the Sessions plugin loaded, authoring sessions open through it, so its sidebar offers a way back to the session you came from.
