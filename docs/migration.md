# Migration to Opcode

These packages are fresh OpenCode V2 implementations, not aliases or V1 adapters.
The original repositories are unchanged.

## Names

| Original | Opcode |
| --- | --- |
| `opencode-context-tui` | `@lidtop/opencode-context` |
| `opencode-cost` | `@lidtop/opencode-cost` |
| `opencode-later` | `@lidtop/opencode-later` |
| `opencode-sessions-all` | `@lidtop/opencode-sessions` |

Remove the old package entry when enabling its replacement to avoid duplicate
commands or tracking. Use the new plugin README's V2 configuration example.

Earlier Opcode drafts used the unscoped npm names `opcode-context`, `opcode-cost`,
`opcode-later`, and `opcode-sessions`. Replace those package entries with the
corresponding `@lidtop/` names too, including any object-form `package` fields.
This changes npm package names only: runtime plugin, command, and RPC IDs remain
`opcode-*`, and legacy `opencode-*` database paths remain unchanged. Do not add the
npm scope to slash commands, RPC IDs, or filesystem paths.

## Data

Opcode uses stable plugin IDs. Later preserves its existing client-local SQLite
path and schema, so its active list and history remain available without an
import. Do not run both versions at once. Back up your database before switching.
Cost and Sessions preserve their legacy local database paths, but the server
now owns those databases and exposes them through plugin RPC. A remote client
therefore sees the connected server's ledger/index, not its own local copy.
Their package READMEs describe compatibility details. Keep the old
data and package configuration until you have verified the replacement. No
migration process should delete the original data.

## Validation

Automated domain and adapter tests cannot prove interactive terminal behavior.
Before switching your daily setup, exercise commands in OpenCode 2.1.1 or a
compatible V2 release; check narrow terminal layouts, Escape/keyboard handling,
theme changes, plugin reload cleanup, and remote-client behavior. Cost requires
its server entrypoint on the connected server, as do Sessions and Context's tool
inventory. Later's list remains client-local even
when the connected server is remote; its agent tools then edit a list on the server's machine.
