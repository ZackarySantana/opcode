# @lidtop/opencode-snippets

Stop retyping the prompts you use every day. Save reusable prompt text as snippets, drop one into any message with `@name`, and save or change snippets by asking the agent you're working with, or in the built-in editor.

## Install

Requires OpenCode **2.2.0 or newer in the 2.x line**.

```sh
opencode plugin add @lidtop/opencode-snippets
```

Or add it to `plugins` in your global `~/.config/opencode/opencode.jsonc` (or `opencode.json`), keeping your existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-snippets"]
}
```

**Where it runs.** The OpenCode server reads and writes snippet files and expands them; the terminal view and the desktop app ask the server for them. With a remote server, snippets live on that server's filesystem.

## Use

Type `@` in a prompt and pick a snippet from OpenCode's own completion, where snippets are listed as skills described as **Snippet · …**. Its text is attached to that message when you send it, while the message still reads `@name`. Later edits to the snippet don't change messages you already sent.

`@name` typed or pasted without the completion works too, when it stands on its own between spaces and names a snippet.

Snippets are not shown to the model as skills it may load on its own. Only the ones you mention are sent.

### Save snippets from the chat you're in

The agent in every session has snippet tools, so you can ask it directly: "save the handoff you just wrote as @ticket", "make @review shorter", "rename @rv to @check and make it a project snippet", or "delete @old". It saves exactly the text you want reused, and **you approve every write and delete** in OpenCode's permission prompt. Choosing **Allow always** there approves later changes to that one snippet in this project.

`/snippets save` types "Save as a snippet: " into the prompt for you to finish, and `/snippets save the plan above` sends that request to the agent right away. Neither opens another session.

The tools tell the agent to use them only when you ask about snippets. To keep the agent from seeing them at all, set the plugin option `agentTools` to `false`:

```jsonc
{
  "plugins": [["@lidtop/opencode-snippets", { "agentTools": false }]]
}
```

Your own permission rules for `snippet_write` and `snippet_delete` on an agent win over the plugin's ask rules, so an agent configured to deny them keeps denying.

### Manage

Run `/snippets` or select **Snippets** in the command palette. It opens a dialog with project snippets and global snippets on separate tabs (`tab` switches; a project without snippets of its own opens on the global ones). Beside the list is a preview of the outlined snippet: its scope, file, description, aliases, any problems, the snippets that use it, and its text as written, with references to other snippets in purple.

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move selection |
| `tab` / `shift+tab` | Switch between the project and global tabs |
| `enter` | Close the dialog and insert `@name ` into the prompt under it (nothing is submitted). Over another plugin's page there is no prompt, so the dialog stays open |
| `e` | Edit the selected snippet |
| `n` | Write a new snippet, in the open tab's scope |
| `y` | Duplicate the selected snippet under a free `name-copy` |
| `d` | Delete the selected snippet's file, after a confirmation that names the snippets whose references would stay as typed |
| `pgup` / `pgdn`, `shift+↑` / `shift+↓` | Scroll the preview of a long snippet |
| `/` | Search names, aliases, descriptions, and text |
| `r` | Refresh |
| `esc` | Leave the search, clear it, then close the dialog |

The list marks a global snippet **overridden** when a project snippet has the same name, **skill conflict** when another skill already uses its name (it is not inserted by `@name`; rename it), and **broken reference** when one of its references stays as typed.

### Edit

`e`, `n`, `y`, and `/snippets new` open the editor, with fields for the name, scope, description, aliases (separated by spaces or commas), and the text. References to other snippets in the text turn purple as you type them.

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | Next or previous field (`enter` also moves on, except in the text, where it starts a new line) |
| `↑` / `↓` | Previous or next field; in the text, the previous or next line, then the field above from its first line |
| `space`, `←` / `→` | On the scope, switch between global and project |
| `ctrl+s` | Save |
| `esc` | Back to the list, or close when the editor was opened on its own; asks first if anything changed |

Changing an existing snippet's name or scope renames or moves its file. A save that would replace another snippet, or with an invalid name, alias, or reference, keeps the editor open with the reason. Saving from the editor doesn't ask for approval: you are the one writing.

**Save Message as Snippet** in the command palette lists this session's recent messages, yours and the agent's, and opens the editor with the one you pick.

### Desktop

In the desktop app, from a session:

- `/snippets` (or **Snippets** in the command palette) opens a dialog with a search field and the list on the left and a preview on the right, showing the text as written with references in purple. **Insert** (or `enter` in the search, or a double click) types `@name ` into the prompt. **Edit**, **Duplicate**, **Delete**, and **New snippet** work as in the terminal, in an editor inside the dialog. `↑` / `↓` move the selection, and in the editor `ctrl+enter` (`⌘+enter` on macOS) saves.
- `/snippets new` opens the editor, and `/snippets save [what]` asks the session's agent, as in the terminal.
- **Save Prompt as Snippet** opens the editor with the prompt you are writing. After saving, it offers to replace the prompt with `@name `.
- **Save Message as Snippet** picks one of the session's messages.

Snippets come from the session's server and directory. Closing the dialog with `esc` or a click outside it discards unsaved editor changes; **Cancel** asks first.

## Files

Each snippet is a Markdown file named after it, with optional frontmatter:

```markdown
---
description: "Review the current diff"
aliases: [rv]
---

Review the current changes for correctness, missing tests, and unclear names. Be brief.
```

| Scope | Directory |
| --- | --- |
| Global | `$XDG_CONFIG_HOME/opencode/snippets/` (or `~/.config/opencode/snippets/`) |
| Project | `.opencode/snippets/` at the repository root (or in the directory OpenCode opened, outside a repository) |

- Names are lowercase letters and digits joined by single hyphens, with at least one letter, such as `review` or `pr-2`.
- A project snippet replaces a global one with the same name. A name always wins over another snippet's alias.
- The body is inserted as written. There is no templating, arguments, or shell substitution.
- Files you edit by hand are picked up as soon as they are saved, including in `@` completion. Global snippet files may be symlinks, for example into a dotfiles checkout, and writes update the file they point to. Project snippets must be regular files, so a cloned repository cannot point a snippet at a file elsewhere on your machine. Bodies are limited to 64 KiB.

### Use other snippets

A snippet can use another one by writing `@name` on its own between spaces, the same way you would in a message:

```markdown
---
description: "Work a ticket end to end"
---

Read the ticket, implement it, then:

@review
```

Sending `@ticket` attaches its text with `@review` replaced by the current text of `review`, so editing `review` changes what `@ticket` sends without touching `ticket`. References nest, and resolve the way `@name` does in a prompt: by name or alias, with a project snippet in place of a global one with the same name, even inside a global snippet.

- A reference that is no snippet, such as `@someone`, or that leads back to a snippet already being expanded stays as typed. The same goes for every reference in a snippet that would grow past 64 KiB with them.
- Saves from the agent or the editor must use only existing snippets, with no loops, and global snippets only global ones. Deleting or renaming a snippet names the snippets that used it.
- `/snippets` and the desktop list mark a snippet with a reference that stays as typed **broken reference**.
- A message that mentions both `@ticket` and `@review` gets the review text twice.

## Limitations

- OpenCode wraps the attached text the way it wraps skills, so the model sees it inside a skill block rather than as plain prompt text.
- A skill with the same name from another source takes precedence, and that name stays unavailable as a snippet.

## Development

From the repository root:

```sh
mise exec -- bun test plugins/snippets/test
mise exec -- bun run typecheck
mise run dev snippets
```

The build bundles the private `@opcode/core`, `@opcode/tabs`, and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external.
