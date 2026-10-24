# @lidtop/opencode-cost

See where your usage goes: recorded costs and tokens across projects and models, with daily activity over time. Costs come from OpenCode's provider-reported records, not a separate pricing table.

![Cost dashboard with usage totals, model and project breakdowns, and daily activity ordered newest first](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/cost-dashboard.png)

## Install

Requires OpenCode **2.1.3 or newer in the 2.x line**.

```sh
opencode plugin add @lidtop/opencode-cost
```

Or add it to `plugins` in your global `~/.config/opencode/opencode.jsonc` (or `opencode.json`), keeping your existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-cost"]
}
```

**Where it runs.** Install it globally so the server collector is available across projects. The server records usage and owns the database; the terminal dashboard queries it over plugin RPC (both parts use the ID `opcode-cost`). A client-only install in `cli.json` cannot supply that RPC service, so the dashboard needs the server plugin enabled at the connected location.

## Use

Run `/cost` or select **Cost** in the command palette.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Scroll |
| `d` | Date range: today, last 7 days, last 30 days, or all time |
| `p` | Filter by project |
| `m` | Filter by provider and model |
| `x` | Reset to 30 days and all projects and models |
| `r` | Refresh and reconcile the current project's complete history; retry failed imports |
| `esc` | Return to the originating session, home, or plugin page |

Totals show USD cost, **recorded messages**, and input, output, reasoning, cache-read, and cache-write tokens. Model and project breakdowns show the top eight by cost; daily activity shows the last 14 dates with recorded usage, newest first. Totals are never truncated. Selecting an entity hides its redundant breakdown, but daily activity stays available even on narrow terminals with both filters selected.

The view rereads the server ledger every five seconds while open and shortly after public usage updates. Date filters use the **server's local calendar**, include today, and attribute usage to message creation time. Filter pickers show entities present in the selected range. The project picker shows each project's path beside its name; a project is named after its most recently used directory, and choosing one includes its recorded worktrees.

## Collection and history

The server records completed and failed assistant steps, including headless usage, and completed compactions with model metadata. It filters the cross-location event stream against each session's directory, reconnects after the stream ends, and cancels outstanding work on unload.

Historical import runs when the terminal plugin loads or changes location, and on `r`. OpenCode 2.1.1 exposes full message history only through the terminal client, so the terminal reads all assistant and compaction pages for **every session in the current project, including other worktrees**, extracts usage metadata, and sends validated batches of at most 100 messages to the server. The server derives project, session, and location identity from its own session lookup. Prompts and summaries are never sent.

- **Safe to repeat:** imports are cancellable and idempotent, and each batch is atomic. Changing location cancels the previous import; a failure is shown only while its location is current. Retries scan again without double-counting, and old completion markers never permanently skip reconciliation. Projects never opened in a terminal are not imported until opened.
- **Live wins:** history never overwrites a message collected live. For legacy or historical records, only a later completion timestamp replaces existing values, and incomplete snapshots cannot erase completed usage. Duplicate live updates replace existing values; older live events are ignored. A failed step that reports no usage keeps any usage already recorded for its message.
- **Moves and forks:** message identity stays stable when OpenCode moves a session between projects, and reconciliation updates its attribution without touching protected costs. Forks can inherit their parent's message IDs; each ID is billed once, stays attributed to the first recorded session, and later duplicates are skipped without blocking the rest of the batch.

## Accounting

- Costs come directly from OpenCode records; there is no provider pricing table or price recalculation.
- A recorded message is an assistant step or an eligible completed compaction, not a user turn and not necessarily one provider request. Incomplete or failed steps can be recorded with zero usage. Title and transient generation are not collected separately, so this is not an exhaustive invoice.
- Missing, non-finite, or negative usage values count as zero.
- Public events have no replay: reconnecting alone cannot recover missed usage, so use `r` to reconcile. Records deleted from OpenCode before collection or import cannot be recovered.
- Recorded usage remains after its session is deleted. There is no pruning, budget alerts, export, or billing integration.

## Options

Set a custom database path on the **server**:

```jsonc
{
  "plugins": [
    { "package": "@lidtop/opencode-cost", "options": { "database": "/absolute/path/cost.sqlite" } }
  ]
}
```

- `database`: where the ledger is stored. Relative paths resolve from the server's OpenCode state directory. `:memory:` works but is not durable. With a remote server, paths and environment variables belong to that machine. The default is `$XDG_STATE_HOME/opencode/opencode-cost/cost.sqlite` (or `~/.local/state/opencode/opencode-cost/cost.sqlite`).

## Data and privacy

**Only the server opens SQLite.** The terminal never reads or writes a local cost database, so a remote dashboard shows the **connected server's ledger**, and imported remote history stays on that server. Local and remote histories are never mixed.

The database stores IDs, directories, model and provider IDs, timestamps, costs, and token counts only: no prompts, responses, tool arguments, file contents, or credentials. Full history is fetched transiently for metadata extraction. To clear history, stop OpenCode and remove the database and its SQLite sidecars; there is no delete action in the dashboard.

## Replacing opencode-cost

The default database path is the same as `opencode-cost`'s, and its `usage` and `backfill` tables are kept without conversion; an added `opcode_cost_live` table tracks live-write precedence. Remove the old plugin before enabling this one to avoid competing collectors and `/cost` commands. An old local database is not transferred to a remote server automatically.

## Development

From the repository root:

```sh
mise exec -- bun test plugins/cost/test
mise exec -- bun run typecheck
mise run dev cost
```

The build bundles the private `@opcode/core` and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external.
