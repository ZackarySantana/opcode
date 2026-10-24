# @lidtop/opencode-feed

Know what's down before you debug. Follow the status pages and release feeds you depend on, with what's in progress in the sidebar and the full picture one command away.

![Feed Status tab with in-progress Claude and OpenAI incidents and operational status pages grayed out at the top](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/feed-status.png)

## Install

Requires OpenCode **2.1.3 or newer in the 2.x line**.

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

Run `/feed` or select **Feeds** in the command palette. The dialog has five tabs:

- **Status:** in-progress incidents first, operational status pages grayed out, then recent status posts.
- **Upcoming:** scheduled maintenance from status pages.
- **Releases:** recent posts from release feeds.
- **Subscribe:** choose presets, or paste any RSS or Atom URL.
- **Settings:** the time window, where resolved incidents and releases appear, how many items the sidebar lists, and how often feeds refresh.

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | Next / previous tab |
| `↑` / `↓`, `j` / `k` | Move the outline |
| `/` | Focus the box at the top: search, or paste a URL in Subscribe |
| `enter` | Open the outlined item's link, as clicking it does (Status, Upcoming, Releases); subscribe or add (Subscribe) |
| `space` | Subscribe or unsubscribe (Subscribe) |
| `f` | Pick one feed of the tab's kind to show its latest 20 items (Status, Upcoming, Releases) |
| `←` / `→`, `h` / `l` | Change the outlined setting (Settings) |
| `d` | Remove a custom feed (Subscribe) |
| `r` | Refresh every feed now (also `/feed-refresh`, or **Refresh feeds** in the command palette) |
| `esc` | Leave the box, clear the search, close the picker, show all feeds, then close |

Changing tabs clears the search and the chosen feed. While typing in the box, the arrow keys still move the outline and `enter` acts on it.

On Status, in-progress incidents come first, colored by urgency: red while investigating or identified, yellow while monitoring or during maintenance. Status pages with nothing in progress are listed, grayed out, at the top. Everything else from the time window follows, newest first. Future-dated items, such as scheduled maintenance, appear under Upcoming instead.

The sidebar shows only what needs attention: up to five items by default (see **Sidebar items** below), then the two soonest scheduled items, with a count of the rest and a pointer to `/feed`, then any unreachable feeds. Operational status pages are left out; with nothing to list it reads "Nothing in the last 12 hours" (your time window). By default it leaves out release feeds, keeping it for incidents; see **Sidebar releases** below. It ends with a countdown to the next refresh, or "Refreshing…" while feeds are being fetched. It is omitted when you have no subscriptions; the plugin never forces it open. Click an item or scheduled maintenance there to open its link, as `enter` does in `/feed`; click a "+N more" line to open the dialog.

Links open in your browser with `open` (macOS), `rundll32` (Windows), or `xdg-open` (Linux); on WSL it tries `wslview`, `xdg-open`, then PowerShell. Only `http` and `https` links are opened.

## Subscriptions

Each subscription is a **status page** or a **release feed**:

- **Status pages** report incidents and maintenance. Statuspage, incident.io, and Google dashboard formats are recognized; other status feeds are judged by their wording ("resolved", "operating normally"). A status page with nothing in progress, including an empty feed, counts as operational.
- **Release feeds** are releases, blogs, and news, shown on the Releases tab. They are never read as incidents, and each contributes at most its three newest items so a busy feed cannot crowd out the others.

Presets include npm, GitHub, Docker, CircleCI, Google Workspace, Google Cloud, Claude, OpenAI, Cursor, DeepSeek, Cloudflare, Fireworks, AWS, Azure, Fly.io, Vercel, Supabase, Sentry, and Slack status pages, plus Claude Code, OpenCode, Antigravity CLI, Bun, Node.js, and VS Code releases, OpenRouter models, the Claude Platform release notes, the Codex and GitHub changelogs, the TypeScript, Go, Deno, and React blogs, the AWS News Blog, OpenAI news, and Hacker News (300+ points). To add any other RSS or Atom feed, paste its URL in the Subscribe tab's box and choose **Add as status page** or **Add as release feed**.

## Settings

| Setting | Choices | Default |
| --- | --- | --- |
| Time window | 6h, 12h, 24h, 2d, 3d, 7d | 12h |
| Show resolved | Both, Sidebar, /feed, None | None |
| Sidebar releases | No, Yes | No |
| Sidebar items | 3, 5, 10, 15, 20 | 5 |
| Refresh every | 1m, 5m, 10m, 15m, 30m, 1h | 10m |

The window sets how far back Status and Releases look and how far ahead Upcoming looks; in-progress incidents always show, for up to seven days. **Show resolved** chooses where resolved and completed incidents appear. Posts from release feeds always appear on the Releases tab; **Sidebar releases** adds them to the sidebar too. Showing a single feed with `f` ignores the window, the three-item cap, and Show resolved. **Sidebar items** sets how many items the sidebar lists, in-progress incidents first, before pointing to `/feed`; the two soonest scheduled items show below them either way.

**Refresh every** sets how often every feed is fetched, including unreachable ones; changing it restarts the countdown. `r`, `/feed-refresh`, and **Refresh feeds** fetch every feed now and also restart it. A failed fetch is retried twice within a few seconds before the feed shows as unreachable, so brief outages and network blips recover on their own. After your computer sleeps, an overdue refresh starts within a minute of waking.

## Options

Load the plugin in global `~/.config/opencode/cli.json` to pass options; server-loaded terminal extensions in OpenCode 2.1.1 do not reliably receive server plugin options.

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    { "package": "@lidtop/opencode-feed", "options": { "database": "/absolute/path/feed.sqlite" } }
  ]
}
```

- `database`: where subscriptions and settings are stored. Relative paths resolve from the client's `$XDG_STATE_HOME/opencode` (or `~/.local/state/opencode`), not the project directory. The default is `$XDG_STATE_HOME/opencode/opcode-feed/feed.sqlite` (or `~/.local/state/opencode/opcode-feed/feed.sqlite`).

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
