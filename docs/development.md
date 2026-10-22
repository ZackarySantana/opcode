# Local development

From the checkout root:

```sh
mise run dev
```

Requires [mise](https://mise.jdx.dev/) and OpenCode V2. The launcher installs
dependencies, builds every plugin, and opens OpenCode with them enabled. To
preview just one:

```sh
mise run dev cost
```

Try `/context`, `/cost`, `/later`, `/feed`, and `/opcode-sessions` (avoids the
built-in `/sessions` command). Relaunch after editing code to rebuild.

Preview plugin databases persist in `.release/dev/data`, separate from the
original plugins' databases. The launcher does not edit global configuration; it
temporarily replaces the four originals and uses the preview extensions instead
of your CLI-only plugin list. Later and Feed are configured on the CLI side so
their client-local database options reach the TUI.

**The preview uses a private server but your normal OpenCode login/session
database.** It is not a sandbox: submitted prompts behave normally and may incur
model costs. For isolated checks, see [verification](verification.md).

## Checks

```sh
mise run check
```

Mise pins Bun 1.4.3 and Node 24.22.0. Keep third-party versions in the root
workspace catalog and update the OpenCode packages together.

`plugins/` contains independently released packages. `packages/ui` and
`packages/core` are private source workspaces bundled into each plugin; OpenCode,
OpenTUI, and Solid remain external. See [architecture](architecture.md) and
[releases](releases.md) for ownership and packaging details.

## README screenshots

The root README uses seven PNG captures under `docs/images/`. They show real V2
terminal views, not UI mockups: fictional demo data, except Feed's real public
status feeds. See the
[capture notes](images/README.md) for the theme, dimensions, and data boundaries.
When updating them, keep private session text and paths out of the images:

| File under `docs/images/` | Capture |
| --- | --- |
| `later-sidebar.png` | An active session with a few Later items in the sidebar |
| `later-manager.png` | An ordered active list with completed history visible |
| `context-overview.png` | A populated Overview with recorded usage and context estimates |
| `context-content.png` | Content ranked by retained contributors |
| `cost-dashboard.png` | Nonzero usage across several models, projects, and dates |
| `sessions-browser.png` | Search matches across projects with a message preview |
| `feed-status.png` | The Status tab with in-progress incidents and operational status pages |

Use the same theme and terminal font throughout. Each Later/Context pair should
have matching dimensions. Crop Context to the actual dialog so its text remains
readable in the paired README layout. Cost must show newest-first daily activity.
