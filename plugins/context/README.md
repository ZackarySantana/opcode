# @lidtop/opencode-context

See what's taking up space in your current OpenCode session: recorded token usage, estimated context utilization, cache efficiency, and the largest visible contributors. The report never calls a model.

[![Watch the Context demo: a session's limit, utilization, cache efficiency, and the test log taking up most of its context](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/context-demo.jpg)](https://github.com/user-attachments/assets/9fe6207a-63a4-4779-8eea-929bb9e0065e)

*The 35-second demo uses a sample session.*

![Context overview with recorded token usage, estimated utilization, cache efficiency, and session activity](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/context-overview.png)

![Context Content tab ranking retained tool outputs and messages by estimated tokens](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/context-content.png)

## Install

Requires OpenCode **2.2.0 or newer in the 2.x line**.

```sh
opencode plugin add @lidtop/opencode-context
```

Or add it to `plugins` in your global `~/.config/opencode/opencode.jsonc` (or `opencode.json`), keeping your existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-context"]
}
```

**Where it runs.** The terminal client builds the report. The server part only exposes a read-only tool catalog (RPC `opcode-context`, method `tools`), so configure the plugin on a remote server to include that server's tools. A client-only install in `~/.config/opencode/cli.json` still works, with a visible missing-tool-catalog warning.

## Use

Run `/context` or select **Context** in the command palette. Run it again to inspect another session.

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | Next / previous tab |
| `↑` / `↓`, `j` / `k` | Select rows, or scroll Overview |
| `r` | Refresh |
| `e` | Export a metadata snapshot |
| `esc` | Close |

- **Overview:** selected model, context limit, recorded assistant telemetry, estimated utilization, cache efficiency, activity, and provenance and limitations. Narrow layouts stack the sections, and Overview scrolls when needed.
- **Content:** the largest observable retained text, reasoning, summaries, tool outputs, and attachment metadata, ranked by estimated tokens.
- **Environment:** configured instruction and skill sources, available agents and skills, MCP statuses, and tool descriptions. This is an inventory, not a reconstruction of the exact provider request.

While open, completed session events (not streaming deltas) trigger coalesced refreshes of session data; environment and catalog data reload on open and `r`. Degraded sources are visibly marked, with details in Overview and exports. History totals can use explicitly labeled cached data. **If retained context is unavailable, retained size and utilization stay unavailable; full history is never relabeled as retained context.**

## Accounting

- **Recorded:** assistant-message input, cache read/write, output, and reasoning telemetry across history. This is not complete billing: compaction telemetry is excluded, and the session may have used several models.
- **Measured:** UTF-16 string lengths and UTF-8 byte counts of observable retained content.
- **Estimated:** `ceil(characters / 4)` per contributor, summed. Utilization divides this by the selected model's context limit and can exceed 100%.

Attachment payloads, opaque provider checkpoints, tool inputs and schemas, and hidden provider or system layers are not measured. The final request is not observable through this report. Environment entries do not count toward the retained estimate. Cache read efficiency is `read / (fresh input + cache read + cache write)`, the share of recorded input served from cache.

## Options

None. There is no normal-use persistence and no background model work.

## Data and privacy

Press `e` after loading completes to write a JSON snapshot on the **terminal client's machine**, including when connected to a remote server:

```text
$XDG_STATE_HOME/opencode/opcode-context/exports/
# or, when XDG_STATE_HOME is unset:
~/.local/state/opencode/opcode-context/exports/
```

New directories use `0700`; files use `0600`, exclusive creation, and unique filenames. Existing directory permissions are not changed.

Snapshots contain counts, identifiers, contributor labels, environment metadata, and limitations, not conversation text, reasoning, tool outputs, or attachment data. Every string goes through best-effort credential redaction, including common token prefixes, Bearer credentials, secret assignments (also prefixed names such as `OPENAI_API_KEY=`), URL credentials for any scheme, and `key`/signature query parameters. Metadata can still contain sensitive names, paths, or unrecognized secrets: **review before sharing**. Nothing is uploaded.

## Replacing opencode-context-tui

Remove the old `opencode-context-tui` entry to avoid duplicate `/context` commands. The plugin and RPC ID is now `opcode-context`; old exports are not migrated.

## Development

From the repository root:

```sh
mise exec -- bun test plugins/context/test
mise exec -- bun run typecheck
mise run dev context
```

The build bundles the private `@opcode/core` and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external.
