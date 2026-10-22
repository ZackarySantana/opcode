# @lidtop/opencode-feed

Follow the status pages and release feeds you depend on, inside the OpenCode V2 terminal UI. `/feed` shows one timeline across your subscriptions; the session sidebar shows what's in progress and what's coming up.

## Install

Requires OpenCode **2.1.1 or newer in the 2.x line**, with its Bun terminal plugin runtime. Add the package to your global `~/.config/opencode/opencode.jsonc`, preserving existing settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-feed"]
}
```

The main entrypoint is inert. OpenCode automatically loads its `./tui` extension. Alternatively, put the same plugin entry in global `~/.config/opencode/cli.json` for client-only loading independent of server configuration. **Do not configure both.** Restart the terminal client if necessary.

Feeds are fetched by the **terminal client**, and subscriptions are stored on its filesystem, including when connected to a remote OpenCode server. A fresh install has no subscriptions.

## Use

Run `/feed` or select **Feeds** in the command palette. The dialog has four tabs: Timeline, Upcoming, Edit, and Settings.

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | Next / previous tab |
| `↑` / `↓`, `j` / `k` | Move the outline |
| `/` | Focus the box at the top: search, or paste a URL in Edit |
| `enter` | Open the outlined update's link (Timeline, Upcoming); subscribe or add (Edit) |
| `space` | Subscribe or unsubscribe (Edit) |
| `f` | Pick one feed to show its latest 20 items (Timeline, Upcoming) |
| `←` / `→`, `h` / `l` | Change the outlined setting (Settings) |
| `d` | Remove a custom feed (Edit) |
| `r` | Refresh every feed now |
| `esc` | Leave the box, close the picker, clear the search, show all feeds, then close |

Changing tabs clears the search and the chosen feed. While typing in the box, the arrow keys still move the outline and `enter` acts on it.

### Timeline and sidebar

In-progress incidents come first, colored by urgency: red while investigating or identified, yellow while monitoring or during maintenance. Status pages with nothing in progress are listed, grayed out, at the top. Everything else from the time window follows, newest first. Future-dated items, such as scheduled maintenance, appear under Upcoming instead.

The sidebar shows the same timeline in short form: up to five updates, then the two soonest scheduled items, with a count of the rest and a pointer to `/feed`. It is omitted when you have no subscriptions; the plugin never forces it open.

`enter` opens links in your browser through `open` (macOS), `wslview`, `xdg-open`, or PowerShell (WSL, in that order), or `rundll32` (Windows). Only `http` and `https` links are opened.

### Subscriptions

Each subscription is a **status page** or an **updates feed**:

- **Status pages** report incidents and maintenance. Statuspage, incident.io, and Google dashboard formats are recognized; other status feeds are judged by their wording ("resolved", "operating normally"). A status page with nothing in progress, including an empty feed, counts as operational.
- **Updates feeds** are releases, blogs, and news. They are never read as incidents, and each contributes at most its three newest items to the timeline so a busy feed cannot bury an outage.

Presets include npm, GitHub, Google Workspace, Google Cloud, Claude, OpenAI, Cloudflare, Fireworks, AWS, Azure, Fly.io, and Slack status pages, plus Claude Code, OpenCode, Bun, and Node.js releases, OpenRouter models, the GitHub changelog, the TypeScript, Go, and Deno blogs, OpenAI news, and Hacker News (300+ points). To add any other RSS or Atom feed, paste its URL in Edit's box and choose **Add as status page** or **Add as updates feed**.

### Settings

| Setting | Choices | Default |
| --- | --- | --- |
| Time window | 6h, 12h, 24h, 2d, 3d, 7d | 12h |
| Show resolved | Both, Sidebar, /feed, None | None |

The window sets how far back the timeline looks and how far ahead Upcoming looks; in-progress incidents always show, for up to seven days. Showing a single feed with `f` ignores the window, the three-item cap, and the resolved setting.

## Options

Load the plugin in global `~/.config/opencode/cli.json` to pass options; server-loaded TUI extensions in OpenCode 2.1.1 do not reliably receive server plugin options.

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "@lidtop/opencode-feed",
      "options": { "database": "/absolute/path/feed.sqlite", "interval": 10 }
    }
  ]
}
```

- `database`: where subscriptions and settings are stored. Relative paths resolve from the client's `$XDG_STATE_HOME/opencode` (or `~/.local/state/opencode`), not the project directory. The default is `$XDG_STATE_HOME/opencode/opcode-feed/feed.sqlite`.
- `interval`: minutes between automatic refreshes. Default 10.

The database holds subscribed URLs, their titles, and your settings. Fetched items are kept in memory only.

## Development

From the monorepo root:

```sh
mise exec -- bun test plugins/feed/test
mise exec -- bun run typecheck
mise run dev feed
```

The root build compiles `src/index.ts` and `src/tui.tsx`, bundling the private `@opcode/core` and `@opcode/ui` workspaces while keeping OpenCode, OpenTUI, and Solid external.
