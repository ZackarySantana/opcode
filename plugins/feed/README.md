# @lidtop/opencode-feed

Know what's down before you debug. Follow the status pages and release feeds you depend on, with what's in progress in the sidebar and a full timeline one command away.

![Feed timeline with in-progress npm, Claude, and OpenAI incidents, operational status pages grayed out, and recent updates](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/feed-timeline.png)

## Install

Requires OpenCode **2.1.1 or newer in the 2.x line**.

```sh
opencode plugin add @lidtop/opencode-feed
```

Or add it to `plugins` in your global `~/.config/opencode/opencode.jsonc` (or `opencode.json`), keeping your existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-feed"]
}
```

**Where it runs.** Feed is a terminal UI plugin; its server entrypoint does nothing. You can instead put the same entry in global `~/.config/opencode/cli.json` to load it on the client only, independent of server configuration. **Do not configure both.** The terminal client fetches the feeds and stores your subscriptions on its filesystem, including when connected to a remote server. A fresh install has no subscriptions.

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

In-progress incidents come first, colored by urgency: red while investigating or identified, yellow while monitoring or during maintenance. Status pages with nothing in progress are listed, grayed out, at the top. Everything else from the time window follows, newest first. Future-dated items, such as scheduled maintenance, appear under Upcoming instead.

The sidebar shows the same timeline in short form: up to five items, then the two soonest scheduled items, with a count of the rest and a pointer to `/feed`. By default it leaves out updates feeds, keeping it for incidents; see **Show updates** below. It is omitted when you have no subscriptions; the plugin never forces it open.

`enter` opens links in your browser with `open` (macOS), `rundll32` (Windows), or `xdg-open` (Linux); on WSL it tries `wslview`, `xdg-open`, then PowerShell. Only `http` and `https` links are opened.

## Subscriptions

Each subscription is a **status page** or an **updates feed**:

- **Status pages** report incidents and maintenance. Statuspage, incident.io, and Google dashboard formats are recognized; other status feeds are judged by their wording ("resolved", "operating normally"). A status page with nothing in progress, including an empty feed, counts as operational.
- **Updates feeds** are releases, blogs, and news. They are never read as incidents, and each contributes at most its three newest items to the timeline so a busy feed cannot bury an outage.

Presets include npm, GitHub, Google Workspace, Google Cloud, Claude, OpenAI, Cloudflare, Fireworks, AWS, Azure, Fly.io, and Slack status pages, plus Claude Code, OpenCode, Bun, and Node.js releases, OpenRouter models, the GitHub changelog, the TypeScript, Go, and Deno blogs, OpenAI news, and Hacker News (300+ points). To add any other RSS or Atom feed, paste its URL in Edit's box and choose **Add as status page** or **Add as updates feed**.

## Settings

| Setting | Choices | Default |
| --- | --- | --- |
| Time window | 6h, 12h, 24h, 2d, 3d, 7d | 12h |
| Show resolved | Both, Sidebar, /feed, None | None |
| Show updates | Both, Sidebar, /feed, None | /feed |

The window sets how far back the timeline looks and how far ahead Upcoming looks; in-progress incidents always show, for up to seven days. **Show resolved** chooses where resolved and completed incidents appear, and **Show updates** where releases, blogs, and news from updates feeds appear; status pages always show. Showing a single feed with `f` ignores the window, the three-item cap, and both of these settings.

## Options

Load the plugin in global `~/.config/opencode/cli.json` to pass options; server-loaded terminal extensions in OpenCode 2.1.1 do not reliably receive server plugin options.

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    { "package": "@lidtop/opencode-feed", "options": { "database": "/absolute/path/feed.sqlite", "interval": 10 } }
  ]
}
```

- `database`: where subscriptions and settings are stored. Relative paths resolve from the client's `$XDG_STATE_HOME/opencode` (or `~/.local/state/opencode`), not the project directory. The default is `$XDG_STATE_HOME/opencode/opcode-feed/feed.sqlite` (or `~/.local/state/opencode/opcode-feed/feed.sqlite`).
- `interval`: minutes between automatic refreshes. Default 10.

## Data and privacy

The database stores subscribed URLs, their titles, and your settings. Fetched items are kept in memory only. Feeds are requested directly from the terminal client, so each feed's server sees your client's IP address; nothing else is sent.

## Development

From the repository root:

```sh
mise exec -- bun test plugins/feed/test
mise exec -- bun run typecheck
mise run dev feed
```

The build bundles the private `@opcode/core` and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external.
