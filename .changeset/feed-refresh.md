---
"@lidtop/opencode-feed": minor
---

Unreachable feeds now recover on their own: a failed fetch is retried twice within a few seconds before the feed shows as unreachable, and unreachable feeds are fetched again on every refresh. A slow request can no longer overwrite a newer result, which could leave a recovered feed marked unreachable, and an overdue refresh starts within a minute of your computer waking from sleep. Choose how often feeds refresh with **Refresh every** in the `/feed` Settings tab (1m to 1h, default 10m); it replaces the `interval` plugin option, which is no longer read. Refresh every feed from anywhere with `/feed-refresh` or **Refresh feeds** in the command palette, and watch the next refresh count down at the bottom of the sidebar's Feeds section.
