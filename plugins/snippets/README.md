# @lidtop/opencode-snippets

Stop retyping the prompts you use every day. Save reusable prompt text as snippets, drop one into any message with `@name`, and write or change snippets by asking for them in a chat.

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

### Manage

Run `/snippets` or select **Snippets** in the command palette. It opens a dialog listing project snippets, then global ones, each with a preview of its text.

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move selection |
| `enter` | Close the dialog and insert `@name ` into the prompt under it (nothing is submitted). Over another plugin's page there is no prompt, so the dialog stays open |
| `n` | Write a new snippet in a new chat |
| `e` | Edit the selected snippet in a new chat |
| `d` | Delete the selected snippet's file, after confirmation |
| `/` | Search names, aliases, descriptions, and text |
| `r` | Refresh |
| `esc` | Leave the search, clear it, then close the dialog |

The list marks a global snippet **overridden** when a project snippet has the same name, and **skill conflict** when another skill already uses its name. A conflicting snippet is not inserted by `@name`; rename it.

### Write snippets in chat

`/snippets new` (or `n` in `/snippets`) opens a new session for writing snippets with instructions for the agent already in the prompt (OpenCode may show them as a "pasted N lines" placeholder), followed by "The following message is what the user wants:". Type what you want after it and send. `/snippets new Never commit until I say so` sends the instructions right away, ending with "The user wants to create a snippet that Never commit until I say so". `e` in `/snippets` opens the same kind of session for the selected snippet. With the Sessions plugin loaded, its sidebar then offers **Back to** the session you came from. Before writing anything, the agent walks you through an example: the name and scope, the exact text, and a sample message that uses it. It creates or updates snippets with its snippet tools, and **you approve every write and delete** in OpenCode's permission prompt, which shows the name, scope, and text. The session uses the model selected in your prompt.

The snippet tools exist only in these sessions. Other sessions never see them.

### OpenCode Desktop

In the desktop app, from a session:

- `/snippets` (or **Snippets** in the command palette) opens a searchable list of project snippets, then global ones, with their descriptions or text, aliases, and **overridden** or **skill conflict** marks. Picking one types `@name ` into the prompt; **New snippet…** at the top writes one in a new chat.
- `/snippets new Never commit until I say so` opens the authoring session with that request right away. Without a request, the app asks what the snippet should do first.
- **Edit Snippet in Chat** and **Delete Snippet** in the command palette pick a snippet, then open an authoring session asking what should change, or delete its file after confirmation.

Authoring sessions open in a new tab on the session's server, with the model selected in your prompt, and work as in the terminal: you approve every write and delete. Snippets come from the session's server and directory.

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
- The body is inserted as written. There is no templating, arguments, shell substitution, or including other snippets.
- Files you edit by hand are picked up the next time you send a message that mentions a snippet, open `/snippets`, or write a snippet. Global snippet files may be symlinks, for example into a dotfiles checkout, and writes update the file they point to. Project snippets must be regular files, so a cloned repository cannot point a snippet at a file elsewhere on your machine. Bodies are limited to 64 KiB.

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
