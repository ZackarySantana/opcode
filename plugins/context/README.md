# @lidtop/opencode-context

Inspect the current OpenCode session with `/context`, without invoking a model.

## Install and compatibility

Requires **OpenCode 2.1.1 or newer in the 2.x line**. This is a V2-only plugin; it does not support V1.

```sh
opencode plugin add @lidtop/opencode-context
```

Or preserve existing entries and add it to `plugins` in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-context"]
}
```

The package has server and CLI entrypoints. The server exposes only a read-only tool-catalog RPC (`opcode-context`, method `tools`); the CLI builds the report. Configure it on a remote service to include that service's tools. A CLI-only installation in `~/.config/opencode/cli.json` still works, with a visible missing-tool-catalog warning.

No plugin options are currently supported. There is no normal-use persistence or background model work. When replacing `opencode-context-tui`, remove its old entry to avoid duplicate `/context` commands. The new plugin/RPC ID is `opcode-context`; old exports are not migrated.

## Modal

- **Overview:** selected model, context limit, recorded assistant telemetry, estimated utilization, cache efficiency, activity, and provenance/limitations. Narrow layouts stack the sections; Overview scrolls when needed.
- **Content:** largest observable retained text, reasoning, summaries, tool outputs, and attachment metadata, ranked by estimated tokens.
- **Environment:** configured instruction/skill sources, available agents/skills, MCP statuses, and tool descriptions. This is an inventory, not a reconstruction of the exact provider request.

Use `h`/`l` or left/right to switch tabs, `j`/`k` or up/down to select rows (or scroll Overview), `r` to refresh, `e` to export, and Escape to close. Overview also supports normal scrollbox scrolling. Open the modal again to inspect another session. It also appears as **Context** in the command palette.

Completed session events (not streaming deltas) trigger coalesced refreshes of session data while open; environment and catalog data reload on open and `r`. Degraded sources are visibly marked; details appear in Overview and exports. History totals can use explicitly labeled cached data. **If retained context is unavailable, retained size/utilization remain unavailable—full history is never relabeled as retained context.**

## Accounting

- **Recorded:** assistant-message input, cache read/write, output, and reasoning telemetry across history. Not complete billing: compaction telemetry is excluded, and the session may have used multiple models.
- **Measured:** UTF-16 string lengths and UTF-8 byte counts of observable retained content.
- **Estimated:** `ceil(characters / 4)` per contributor, summed. Context utilization divides this by the selected model's context limit; values can exceed 100%.

Attachment payloads, opaque provider checkpoints, tool inputs/schemas, and hidden provider/system layers are not measured. The final request is not observable through this report. Environment entries do not contribute to the retained estimate. Cache read efficiency is `read / (fresh input + cache read + cache write)`, the share of recorded input served from cache.

## Private metadata export

Press `e` after loading completes to write JSON on the **terminal client's machine**, including when connected remotely:

```text
$XDG_STATE_HOME/opencode/opcode-context/exports/
```

The default state home is `~/.local/state`. Newly created directories use `0700`; files use `0600`, exclusive creation, and unique filenames. Existing directory permissions are not changed.

Snapshots contain counts, identifiers, contributor labels, environment metadata, and limitations—not conversation text, reasoning text, tool outputs, or attachment data. Every string is passed through best-effort credential redaction, including common token prefixes, Bearer credentials, quoted assignments, and URL credentials. Metadata can still contain sensitive names/paths or unrecognized secrets: **review before sharing**. Nothing is uploaded.

## Development

From the workspace root:

```sh
mise exec -- bun test --preload @opentui/solid/preload plugins/context/test
mise exec -- bun run typecheck
```

The shared UI/core workspaces are bundled into the independently published package. OpenCode, OpenTUI, and Solid remain external.
