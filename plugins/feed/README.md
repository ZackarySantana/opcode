# @lidtop/opencode-feed

Know what's down before you debug. Follow the status pages and release feeds you depend on, with what's in progress in the sidebar and the full picture one command away.

[![Watch the Feed demo: an in-progress incident in the sidebar, then the Status, Upcoming, Releases, and Subscribe tabs](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/feed-demo.jpg)](https://github.com/user-attachments/assets/52f67075-8fe5-4f3a-8e83-599213e15e60)

*The 48-second demo uses sample status feeds, so its incidents are illustrative.*

![Feed Status tab with in-progress Claude and OpenAI incidents and operational status pages grayed out at the top](https://raw.githubusercontent.com/ZackarySantana/opcode/main/docs/images/feed-status.png)

## Install

Requires OpenCode **2.2.0 or newer in the 2.x line**.

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

**Where it runs.** The server side keeps your subscriptions and settings, fetches the feeds on the schedule, and keeps what they say; the sidebar and `/feed` in the terminal show what it has, over plugin RPC (both parts use the ID `opcode-feed`). Configure it where the server reads plugins (this config, or the remote server's), not in `cli.json`: a terminal-only install has no server side to ask, and the sidebar and `/feed` say to add it to the server's plugins. Feeds are fetched from the machine the OpenCode server runs on, which is a remote machine when you connect to one. A fresh install has no subscriptions.

**One source of truth.** Every terminal connected to the same server shows the same subscriptions, settings, and feeds. The server fetches each feed once for all of them, however many terminals or projects are open, and subscribing, unsubscribing, a change to a setting, or a refresh shows in every terminal right away.

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

The sidebar shows only what needs attention: up to five items by default (see **Sidebar items** below), then the two soonest scheduled items, with a count of the rest and a pointer to `/feed`, then any unreachable feeds. Operational status pages are left out; with nothing to list it's just the title. By default it leaves out release feeds, keeping it for incidents; see **Sidebar releases** below. Beside the title, a countdown shows the time to the next refresh, or "refreshing…" while feeds are being fetched. It is omitted when you have no subscriptions, unless the server can't be reached or can't read them, which it says; the plugin never forces it open. Click an item or scheduled maintenance there to open its link, as `enter` does in `/feed`; click a "+N more" line to open the dialog.

Links open in your browser with `open` (macOS), `rundll32` (Windows), or `xdg-open` (Linux); on WSL it tries `wslview`, `xdg-open`, then PowerShell. Only `http` and `https` links are opened.

### Desktop

In OpenCode Desktop, a titlebar pill shows while incidents are in progress ("2 incidents"); click it, select **Feeds** in the command palette, or run `/feed` to open the Feeds dialog. It has Status, Upcoming, and Releases sections grouped as in the terminal, using the same time window and Show resolved setting, and a **Subscriptions** section listing each subscribed feed's state with a button to unsubscribe (after a confirmation). Click an item to open its link in your browser. **Subscribe…** offers the presets you haven't subscribed to, or a custom URL, which then asks whether it is a status page or a release feed. **Refresh** in the dialog, `/feed-refresh`, and **Refresh feeds** fetch every feed now. Settings are changed in the terminal's Settings tab.

The desktop app follows the same server side as the terminals, over the app's own server: subscriptions, settings, and feeds are shared with every terminal connected to it, and changes show everywhere right away. On Home, with no session open, it asks the server's default location. OpenCode Desktop reads plugins only from `opencode.json(c)`.

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

**Refresh every** sets how often every feed is fetched, including unreachable ones; changing it restarts the countdown in every terminal. `r`, `/feed-refresh`, and **Refresh feeds** fetch every feed now and also restart it. A failed fetch is retried twice within a few seconds before the feed shows as unreachable, so brief outages and network blips recover on their own. After the server's machine sleeps, an overdue refresh starts within a minute of waking. The server keeps refreshing while it has the plugin loaded, even with no terminal open.

Subscriptions and settings are saved in the server's plugin storage and shared by every terminal connected to it. If the server can't read them, `/feed` and the sidebar say so, and subscribing, unsubscribing, and changing settings are refused until it can, so what you saved is never replaced. Subscriptions and settings saved by versions before the server kept them aren't carried over: subscribe again, and settings start at the defaults.

## Data and privacy

The server's plugin storage keeps the subscribed URLs, their titles, and your settings. What the feeds say is kept in the server's memory only, and sent to the terminals connected to it. Feeds are requested from the OpenCode server's machine, so each feed's server sees that machine's IP address; nothing else is sent.

Earlier versions kept subscriptions and settings in `opcode-feed/feed.sqlite` in the terminal's OpenCode state directory (`$XDG_STATE_HOME/opencode`, or `~/.local/state/opencode`), or where the `database` option said, which is gone. Nothing reads it now, so you can delete it.

## Development

From the repository root:

```sh
mise exec -- bun test plugins/feed/test
mise exec -- bun run typecheck
mise run dev feed
```

The build bundles the private `@opcode/core`, `@opcode/tabs`, and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external.
