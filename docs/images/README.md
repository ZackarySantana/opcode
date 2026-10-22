# README screenshot notes

These PNGs capture the actual plugin views running in **OpenCode 2.1.1**. The
terminal output was captured through a pseudo-terminal, interpreted with the
workspace's existing headless terminal emulator, and rasterized to PNG. No UI
elements were drawn or rearranged for the screenshots.

- Theme: built-in `opencode`, dark mode.
- Terminal: 144 columns by 42 rows, with animations disabled.
- Font: DejaVu Sans Mono, 20 pixels, with 12-by-24-pixel cells.
- Full terminal captures: 1728 by 1008 pixels.
- Context captures: the actual dialog cropped to 88 by 38 cells, or 1056 by 912
  pixels. Both tabs use the same crop.

## Demo data and safety

Capture used a private standalone OpenCode process with a temporary HOME, config,
session database, and plugin databases. Fictional projects were named
`aurora-web`, `ledger-api`, and `docs-site`.

Sessions were imported through OpenCode's public session-import API. The Later
list and historical cost samples were populated in isolated plugin databases.
Token counts and costs are illustrative fixtures, not real provider invoices.
The free demo model's cost remains zero. No model requests were made, and no
personal sessions, credentials, or production databases were used.

| Image | Contents |
| --- | --- |
| `later-sidebar.png` | Four follow-ups alongside a fictional caching discussion |
| `later-manager.png` | The same active list with two completed items |
| `context-overview.png` | Live imported history, recorded usage, and retained estimates |
| `context-content.png` | The same session's retained tool outputs and messages |
| `cost-dashboard.png` | Three projects/models and daily activity sorted newest first |
| `sessions-browser.png` | Message-text search across the three fictional projects |

## Feed

`feed-timeline.png` is a maintainer's Windows Terminal capture of the `/feed`
dialog in a `mise run dev` preview, 619 by 761 pixels. Unlike the images above,
it shows **real public data**: the preset status pages and feeds as they were at
capture time (npm, Claude, and OpenAI incidents in progress). Feeds are public;
no private sessions, credentials, or paths are visible.

For future captures, use the isolation approach in `test/tui-smoke.ts`. Keep the
screenshots aligned with the current source, preserve visible limitations and
status labels, and never edit an image to hide an application error.
