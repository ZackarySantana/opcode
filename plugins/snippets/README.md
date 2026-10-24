# @lidtop/opencode-snippets

Stop retyping the prompts you use every day. Save reusable prompt text as snippets, drop one into any message with `#name` or `@name`, and write or change snippets by asking for them in a chat.

## Install

Requires OpenCode **2.1.3 or newer in the 2.x line**.

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

**Where it runs.** The OpenCode server reads and writes snippet files and expands them; the terminal view asks the server for them. With a remote server, snippets live on that server's filesystem.

## Use

Type `#name` or `@name` anywhere in a prompt. Both attach the snippet's text to that message when you send it, while the message still reads `#name`. Later edits to the snippet don't change messages you already sent.

- `@name` comes from OpenCode's own `@` completion, where snippets are listed as skills described as **Snippet · …**.
- `#name` needs no completion: type the name. It must start the text or follow a space or an opening bracket, so URL fragments, `a#b`, headings, and `#123` issue references stay as they are. `#name` inside backticks or a fenced code block is left alone too.

Snippets are not shown to the model as skills it may load on its own. Only the ones you mention are sent.

### Manage

Run `/snippets` or select **Snippets** in the command palette.

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move selection |
| `enter` | Return to the prompt you came from and insert `#name ` (nothing is submitted) |
| `n` | Write a new snippet in a new chat |
| `e` | Edit the selected snippet in a new chat |
| `d` | Delete the selected snippet's file, after confirmation |
| `r` | Refresh |
| `esc` | Go back |

The list marks a global snippet **overridden** when a project snippet has the same name, and **skill conflict** when another skill already uses its name. A conflicting snippet is not inserted by `@name` or `#name`; rename it.

### Write snippets in chat

`/snippets new` (or `/snippets new name`) opens a new session for writing snippets. Describe what you want; the agent creates or updates snippets with its snippet tools, and **you approve every write and delete** in OpenCode's permission prompt, which shows the name, scope, and text. `e` in `/snippets` opens the same kind of session for the selected snippet.

The snippet tools exist only in these sessions. Other sessions never see them.

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

The build bundles the private `@opcode/core` and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external.
