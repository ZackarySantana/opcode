# @lidtop/opencode-feed

## 0.4.1

### Patch Changes

- 941f43b: The sidebar no longer lists operational status pages; it shows only incidents, scheduled maintenance, and unreachable feeds. `/feed` still lists every status page.
- bb097fd: Require OpenCode 2.1.3 or newer.
- 1708674: Move Later's prompt paste helper into the shared UI package so Snippets can reuse it. No behavior changes.
- c1cfd3c: Clicking "+N more in /ghpr" or "+N more in /feed" in the sidebar now opens the dialog and keeps it open. Before, the dialog closed again as soon as the mouse button was released.
- 44bad65: The Pull requests and Feeds sidebar sections show their refresh countdown beside the title instead of on a line of their own. Those sections and Agents no longer add a line saying there's nothing to show; they show just the title.
- e85fab8: The shared tabbed dialog can keep its open tab when shown again, for Later. No behavior changes.
- f27f920: The shared item card can lead with its title when an item has no head, for Later. No behavior changes.

## 0.4.0

### Minor Changes

- b7ac06c: Add presets for the Vercel, Docker, Supabase, Cursor, DeepSeek, Sentry, and CircleCI status pages, plus Claude Platform release notes, the Codex changelog, Antigravity CLI and VS Code releases, the React blog, and the AWS News Blog.
- 1368825: Unreachable feeds now recover on their own: a failed fetch is retried twice within a few seconds before the feed shows as unreachable, and unreachable feeds are fetched again on every refresh. A slow request can no longer overwrite a newer result, which could leave a recovered feed marked unreachable, and an overdue refresh starts within a minute of your computer waking from sleep. Choose how often feeds refresh with **Refresh every** in the `/feed` Settings tab (1m to 1h, default 10m); it replaces the `interval` plugin option, which is no longer read. Refresh every feed from anywhere with `/feed-refresh` or **Refresh feeds** in the command palette, and watch the next refresh count down at the bottom of the sidebar's Feeds section.
- 611258a: **Show releases** is now **Sidebar releases**, a No/Yes choice: the Releases tab always shows release posts, and Yes adds them to the sidebar too. Your saved choice carries over: Both and Sidebar become Yes, and /feed and None become No.
- 1ec8d96: Click an item or scheduled maintenance in the sidebar's **Feeds** section to open its link in your browser, as `enter` does in `/feed`; linked items underline on hover. Clicking a "+N more" line opens `/feed`.
- 6c22b99: Add a **Sidebar items** setting to `/feed` Settings: choose how many items the sidebar's Feeds section lists (3, 5, 10, 15, or 20) before pointing to `/feed`. It starts at 5, the previous fixed length, so existing setups look the same.

### Patch Changes

- 86148b3: Click an item in `/feed` to open its link, as `enter` does. In the feed picker, `esc` now clears its search before closing it.
- 439c23e: Tag the package with the `opencode` and `opencode-plugin` npm keywords so plugin directories such as OpenDock can list it.
- 61dcef7: Later and Feed now place their sidebar sections below the ones OpenCode and other plugins add, so GH PR Status's Pull requests comes first. Between themselves, Later and Feed keep the order they're configured in.

## 0.3.0

### Minor Changes

- 8b163bd: Split `/feed` into **Status** and **Releases** tabs, and rename Edit to **Subscribe**: status pages and release feeds (releases, blogs, news) each get their own timeline, and `f` picks from the current tab's feeds. **Show updates** becomes **Show releases**, keeping your saved choice, and Statuspage's "Update" label now reads as "Ongoing".

## 0.2.0

### Minor Changes

- 2745c6e: Add a **Show updates** setting (Both, Sidebar, /feed, None) choosing where releases, blogs, and news from updates feeds appear. It defaults to /feed, so the sidebar shows status pages only; existing settings keep their values.

## 0.1.1

### Patch Changes

- a8e520d: Standardize the package READMEs: install with `opencode plugin add` first, show screenshots, and use the same sections and wording across every plugin.

## 0.1.0

### Minor Changes

- 9965abf: First release: `/feed` shows one timeline across subscribed status pages and release feeds, with in-progress incidents first, operational status pages grayed out, scheduled maintenance under Upcoming, search, a single-feed picker, and links that open in the browser. The session sidebar shows the latest updates and upcoming maintenance.
