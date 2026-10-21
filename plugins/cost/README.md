# opcode-cost

Persistent, provider-reported cost and token usage for OpenCode **2.1.1+ within 2.x**. `/cost` opens a native terminal dashboard built with Opcode's shared UI.

## Install

Add the package globally in `~/.config/opencode/opencode.json(c)` so its server collector is available across projects:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opcode-cost"]
}
```

The package exposes the server plugin at its main entrypoint and the automatically loaded terminal plugin at `./tui`. Both use the ID `opcode-cost`. The dashboard requires the server plugin to be enabled at the connected location; a terminal-only installation cannot supply its RPC service.

## Dashboard

Run `/cost` or select **Cost** in the command palette.

| Key | Action |
| --- | --- |
| `d` | Today, last 7 days, last 30 days, or all time |
| `p` | Filter by project |
| `m` | Filter by provider/model |
| `x` | Reset to 30 days and all projects/models |
| `r` | Refresh and reconcile the current project's complete history; retry failed imports |
| `esc` | Return to the originating session, home, or plugin page |
| Up/Down | Scroll |

Totals show USD cost, **recorded messages**, and input/output/reasoning/cache-read/cache-write tokens. Model/project breakdowns show the top eight by cost; daily activity shows the last 14 dates with recorded usage. Totals are not truncated. Selecting an entity hides its redundant breakdown, but daily content remains available even on narrow terminals with both filters selected.

The view rereads the server ledger every five seconds while open and shortly after public usage updates. Date filters use the **server's local calendar**, include today, and attribute usage to message creation time. Filter selectors show entities present in the selected date range.

## Server-owned storage and remote connections

**Only the server opens SQLite.** The terminal queries that server through documented plugin RPC; it never reads or writes a local cost database.

This deliberately improves on `opencode-cost`: a remote dashboard now shows the **connected remote server's ledger**, not an unrelated local ledger, and imported remote history stays on that server. Local and remote histories are not silently mixed. There is no automatic transfer of an old local database to a remote machine.

The default path intentionally remains compatible with `opencode-cost`:

```text
$XDG_STATE_HOME/opencode/opencode-cost/cost.sqlite
# or ~/.local/state/opencode/opencode-cost/cost.sqlite
```

The existing `usage` and `backfill` tables are preserved. An additional `opcode_cost_live` table tracks live-write precedence and ordering. Existing usage needs no conversion. Stop/remove the old plugin before enabling this replacement to avoid competing collectors and `/cost` commands.

Override the path on the **server**:

```jsonc
{
  "plugins": [
    { "package": "opcode-cost", "options": { "database": "/absolute/path/cost.sqlite" } }
  ]
}
```

Relative paths resolve against the server's OpenCode state directory. `:memory:` is supported but not durable. With a remote server, paths and environment variables belong to that remote machine. To clear durable history, stop OpenCode's service and remove the database and its SQLite sidecars; there is no dashboard delete action.

## Collection and historical reconciliation

The server records completed and failed assistant steps, including headless usage, and completed compactions with model metadata. It filters the cross-location event stream against the session's actual directory, reconnects after stream termination, and cancels outstanding work on unload.

Historical import starts when the terminal plugin loads or changes location, and on `r`. OpenCode 2.1.1 exposes full paginated message history through the terminal client's `message.list`; the server plugin's `session.context` only exposes active context. The terminal therefore reads all pages for **every session in the current project, including other worktrees**, extracts usage metadata, and sends validated batches of at most 100 messages to the server. The server derives project/session/location identity from its own session lookup. Prompts and summaries are never sent in import RPC payloads.

Imports are cancellable and idempotent. Each batch is atomic; partial successful batches remain after interruption, and retries scan again without double-counting. Completion timestamps are informational: old backfill markers **never permanently skip reconciliation**. Pressing `r` retries failed history imports and picks up missed messages. Projects never opened in a terminal are not historically imported until opened.

History cannot overwrite any message collected live by this replacement. For legacy or historical records, only a later completion timestamp can replace existing values; incomplete snapshots cannot erase completed usage. This conservative policy prevents stale historical reads from replacing newer live usage, but does not apply same-completion-time historical corrections. Duplicate live updates replace existing values; older live events are ignored.

Session/message identity remains stable when OpenCode moves a session between projects. Reconciliation updates its server-authorized project/directory attribution independently of usage freshness, so moved records do not block other records in the import batch or replace protected live costs.

Forks can inherit the **same global message IDs** as their parent. Each ID is billed only once, never once per session. When history presents an existing ID under a different session, that record is skipped without changing its cost, model, timestamps, or attribution; other records in the batch still import. This also conservatively protects against unrelated cross-session ID conflicts, because the import RPC authorizes the session but does not independently verify each message's origin. Historical attribution stays with the first recorded session (parent or fork); moves of that recorded session can update attribution as above, and live updates remain authoritative. Fork-only messages import normally, and retries can complete without duplicating inherited costs.

## Accounting limits and privacy

- Costs come directly from OpenCode records; no provider pricing table or price recalculation.
- A recorded message is an assistant step or an eligible completed compaction—not a user turn or necessarily one provider HTTP request. Incomplete/failed assistants can be recorded with zero usage. Title generation and transient generation are not independently collected; this is not an exhaustive provider invoice.
- Missing/non-finite/negative usage values normalize to zero.
- Public events have no replay. Reconnection alone cannot recover missed usage; use historical reconciliation. Records deleted from OpenCode before collection/import cannot be recovered.
- Recorded usage remains after its source session is deleted. No pruning, budget alerts, exports, or billing integration.
- Persisted data is IDs, directories, model/provider IDs, timestamps, costs, and token counts only. No prompts, responses, tool arguments, file contents, or credentials are stored. Full history is fetched transiently for metadata extraction.

## Development

From the workspace root:

```sh
mise exec -- bun test plugins/cost/test
mise exec -- bun run typecheck
```

Tests protect ledger persistence/legacy compatibility, idempotence and stale-write safety, date filters, paginated imports and retry/cancellation, event location filtering, RPC ownership, and lifecycle/navigation behavior. Real-host terminal rendering and remote-server installation still require integration verification.
