# @lidtop/opencode-cost

See where your usage and time go: recorded costs and tokens across projects and models, with daily activity over time, plus a Time tab for how long agents worked, how long they waited on you, and how much ran in parallel. Costs come from OpenCode's provider-reported records, not a separate pricing table.

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
| `tab` | Switch between the Cost and Time tabs (or click a tab) |
| `d` | Date range: today, last 7 days, last 30 days, or all time |
| `p` | Filter by project |
| `m` | Filter by provider and model |
| `x` | Reset to 30 days and all projects and models |
| `r` | Refresh and reconcile the current project's complete history; retry failed imports |
| `j` / `k`, `enter` | Time tab: select a longest turn and open its session (or click it) |
| `esc` | Return to the originating session, home, or plugin page |

Totals show USD cost, **recorded messages**, and input, output, reasoning, cache-read, and cache-write tokens. Model and project breakdowns show the top eight by cost; daily activity shows the last 14 dates with recorded usage, newest first. Totals are never truncated. Selecting an entity hides its redundant breakdown, but daily activity stays available even on narrow terminals with both filters selected.

The view rereads the server ledger every five seconds while open and shortly after public usage updates. Date filters use the **server's local calendar**, include today, and attribute usage to message creation time. Filter pickers show entities present in the selected range. The project picker shows each project's path beside its name; a project is named after its most recently used directory, and choosing one includes its recorded worktrees.

## Time tab

"Where did my time go?" Totals show **agent time** and turn count, **waiting on you**, and **parallel** time with its peak. Like the Cost tab, there are model, project, and daily breakdowns (top eight, newest 14 dates), and the eight longest turns show title, project, model, start, and duration. The date, project, and model filters apply; with a model filter, waiting and parallel time count only that model's turns.

Only **root sessions** are timed; a subagent's work is part of its parent's turn, so it is never counted twice.

- **Turn (agent time):** from the user prompt, or the moment queued input is delivered, until the session goes idle. A prompt steered in while the agent works belongs to the same turn. A turn woken without a prompt, such as by a background subagent finishing, starts at its first recorded step.
- **Waiting on you:** from a turn going idle until the next user prompt in that session, counting at most **30 minutes** per wait so nights away do not count. A turn woken without a prompt leaves no waiting gap. Waits are summed per session, so two sessions waiting at once count twice. A wait belongs to the turn it follows.
- **Parallel:** time with two or more root sessions in a turn at once, and the most at any moment.
- **Model:** each turn is attributed to the provider/model and variant whose steps produced the most output and reasoning tokens. Turns with no recorded step show as "no recorded step".
- **Dates:** a turn belongs to the server's local date on which it started, like usage to message creation.

How times are derived: OpenCode history stores each delivered user prompt as a user message and each finished execution as an idle message, both at the moment of the underlying event. The server records the same moments live from `session.inbox.delivered` (user input only) and `session.execution.succeeded`, `failed`, or `interrupted`, so live collection and import agree without double counting. Import sends just these timestamps, never prompt text. Step times come from the same assistant records as costs.

Limitations:

- Time waiting on a permission or question prompt inside a turn counts as agent time.
- History has no idle marker for a server shutdown mid-turn (live collection records one). Without it, the turn ends at its last recorded step or prompt if the next prompt arrives more than 30 minutes later; otherwise it runs until the next idle. The same rule splits a turn when you steer in a prompt after more than 30 minutes without a step of its own, for example while a long subagent runs.
- A running turn counts up to its latest recorded step or prompt.
- A fork's history before the fork was created is not timed again.

## Collection and history

The server records completed and failed assistant steps, including headless usage, completed compactions with model metadata, and the prompt and idle moments of root sessions. It filters the cross-location event stream against each session's directory, reconnects after the stream ends, and cancels outstanding work on unload.

Historical import runs when the terminal plugin loads or changes location, and on `r`. OpenCode 2.1.3 exposes full message history only through the terminal client, so the terminal reads all assistant, compaction, user, and idle pages for **every session in the current project, including other worktrees**, extracts usage metadata and turn timestamps, and sends validated batches of at most 100 items to the server. The server derives project, session, title, and location identity from its own session lookup. Prompts and summaries are never sent.

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

The database stores IDs, directories, root-session titles, model, variant, and provider IDs, timestamps, costs, and token counts only: no prompts, responses, tool arguments, file contents, or credentials. Full history is fetched transiently for metadata extraction. To clear history, stop OpenCode and remove the database and its SQLite sidecars; there is no delete action in the dashboard.

## Replacing opencode-cost

The default database path is the same as `opencode-cost`'s, but the schema is not compatible: stop OpenCode and remove an existing database and its SQLite sidecars before enabling this plugin, then let the import rebuild history. Remove the old plugin too, to avoid competing collectors and `/cost` commands.

## Development

From the repository root:

```sh
mise exec -- bun test plugins/cost/test
mise exec -- bun run typecheck
mise run dev cost
```

The build bundles the private `@opcode/core` and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external.
