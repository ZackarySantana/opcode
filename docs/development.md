# Local development

From the checkout root:

```sh
mise run dev
```

Requires [mise](https://mise.jdx.dev/) and OpenCode V2. The launcher installs
dependencies, builds all four plugins, and opens OpenCode with them enabled. To
preview just one:

```sh
mise run dev cost
```

Try `/context`, `/cost`, `/later`, and `/opcode-sessions` (avoids the built-in
`/sessions` command). Relaunch after editing code to rebuild.

Preview plugin databases persist in `.release/dev/data`, separate from the
original plugins' databases. The launcher does not edit global configuration; it
temporarily replaces the four originals and uses the preview extensions instead
of your CLI-only plugin list. Later is configured on the CLI side so its
client-local database option reaches the TUI.

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

The root README reserves six screenshot slots using a shared placeholder. Capture
the actual V2 views, without private session text or paths, then replace each
image source with the path in its adjacent HTML comment:

| File under `docs/images/` | Capture |
| --- | --- |
| `later-sidebar.png` | An active session with a few Later items in the sidebar |
| `later-manager.png` | An ordered active list with completed history visible |
| `context-overview.png` | A populated Overview with recorded usage and context estimates |
| `context-content.png` | Content ranked by retained contributors |
| `cost-dashboard.png` | Nonzero usage across several models, projects, and dates |
| `sessions-browser.png` | Search matches across projects with a message preview |

Use the same theme and terminal font throughout. The paired Later/Context images
should have matching dimensions; landscape captures fit the reserved spaces.
