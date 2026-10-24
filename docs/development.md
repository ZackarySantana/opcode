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

Try `/context`, `/cost`, `/later`, `/feed`, `/ghpr`, `/snippets`, and `/sessions-all` (avoids the
built-in `/sessions` command). Relaunch after editing code to rebuild.

Preview plugin databases persist in `.release/dev/data`, separate from the
original plugins' databases. The launcher temporarily replaces the four
originals and uses the preview extensions instead of your CLI-only plugin list.
Later, Feed, and GH PR Status are configured on the CLI side so their client-local database
options reach the TUI. Later is configured on the server side too, with the same
database, for its agent tools; OpenCode still loads its TUI once.

OpenCode loads every configured plugin before applying removals, so a published
`@lidtop/opencode-*` copy in your global `opencode.json(c)` or `cli.json` would
collide with its preview. While OpenCode runs, the launcher takes the previewed
plugins' entries out of those files, rewriting them as plain JSON, and restores
each file exactly on exit, including Ctrl+C or closing the terminal. Other
OpenCode windows, including the background service, lose those plugins until
then. If a file changes during the preview (a setting OpenCode saves, or your
edit), the change is kept and the plugins are added back to it; the comments it
had before stay in its backup. Backups live in `.release/dev/config`, so if the
launcher is killed outright, the next `mise run dev` (or `mise run prod`) from
this checkout restores them. Only one preview or install at a time can hold your
global config.

**The preview uses a private server but your normal OpenCode login/session
database.** It is not a sandbox: submitted prompts behave normally and may incur
model costs. For isolated checks, see [verification](verification.md).

## Published plugins

To use the published packages outside a preview, install or update them
globally:

```sh
mise run prod
```

It runs `opencode plugin update`, which updates every outdated plugin, then
`opencode plugin add` for each `@lidtop/opencode-*` package that is in neither
your global `opencode.json(c)` nor `cli.json`. A plugin already there, pinned to
a version or with options, isn't added again: `opencode plugin add` checks only
exact `opencode.json(c)` entries, so it would add a second copy.
Name plugins to install only those, as with `mise run prod feed`. It refuses
while a preview holds your global config.

## Checks

```sh
mise run check
```

Mise pins Bun 1.4.3 and Node 24.22.0. Keep third-party versions in the root
workspace catalog and update the OpenCode packages together.

`plugins/` contains independently released packages. `packages/ui`,
`packages/tabs`, and `packages/core` are private source workspaces bundled into each plugin that uses them; OpenCode,
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
