# Opcode

A cohesive set of independently installable plugins for **OpenCode V2**.

| Package | Purpose | Replaces |
| --- | --- | --- |
| `@lidtop/opencode-context` | Inspect the current session's context budget | `opencode-context-tui` |
| `@lidtop/opencode-cost` | Track persistent token usage and costs | `opencode-cost` |
| `@lidtop/opencode-later` | Save, organize, and paste deferred prompts | `opencode-later` |
| `@lidtop/opencode-sessions` | Browse sessions across projects | `opencode-sessions-all` |

## Try it locally

```sh
mise run dev
```

Requires mise and OpenCode V2. This command installs checkout dependencies,
builds all four plugins, and opens OpenCode with them enabled. **No manual config
editing or publishing is needed.** To try just one:

```sh
mise run dev cost
# Or, with Bun already installed:
bun run dev
```

Try `/context`, `/cost`, `/later`, and `/opcode-sessions` (avoids the built-in
`/sessions` command). Relaunch the command after
editing code to rebuild. Preview plugin databases persist in `.release/dev/data`
and are separate from the original plugins' databases. The launcher does not edit
global configuration; it temporarily replaces the four originals and uses
the preview extensions instead of your CLI-only plugin list. Later is configured
on the CLI side so its client-local database option reaches the TUI.

OpenCode uses a private server but **your normal OpenCode login/session database**.
This is a convenient preview, not a sandbox: prompts you submit behave normally
and may incur model costs. For an isolated, noninteractive check, see
[verification](docs/verification.md).

## Development checks

```sh
mise run check
```

Mise pins Bun 1.4.3 and Node 24.22.0 (for npm packing/release tooling). The root
workspace catalog is the single source of third-party dependency versions;
update the OpenCode packages together. Public npm installation instructions live
in each plugin's README; external testers need a published version, not this
checkout's workspace manifests.

## Layout

```text
plugins/             Independently versioned, public @lidtop/opencode-* packages
packages/ui/         Private shared terminal components and semantic styling
packages/core/       Private host-independent utilities
scripts/             Shared build, package validation, and release tooling
```

Shared workspaces are bundled into each plugin. OpenCode, OpenTUI, and Solid stay
external so the host owns their runtime instances. Plugins do not import one
another, and installing one does not install the rest.

See each plugin's README for setup and commands, and
[release instructions](docs/releases.md) for GitHub Actions and npm setup.
The [architecture](docs/architecture.md), [migration notes](docs/migration.md), and
[verification checklist](docs/verification.md) describe ownership and validation
boundaries.

## Rewrite policy

The sibling repositories are behavioral references, not runtime dependencies.
Domain logic, OpenCode adapters, and UI stay separate. Host dialogs handle common
search/selection tasks; custom views use shared components and theme tokens.
Existing package state is not silently overwritten or imported. See
[migration notes](docs/migration.md) for compatibility details.
