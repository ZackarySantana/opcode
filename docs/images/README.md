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

`feed-status.png` is a maintainer's Windows Terminal capture of the `/feed`
Status tab in a `mise run dev` preview, 615 by 772 pixels. Unlike the images
above, it shows **real public data**: the preset status pages as they were at
capture time (Claude and OpenAI incidents in progress). Feeds are public;
no private sessions, credentials, or paths are visible.

For future captures, use the isolation approach in `test/tui-smoke.ts`. Keep the
screenshots aligned with the current source, preserve visible limitations and
status labels, and never edit an image to hide an application error.

## Demo videos

Later, Context, Cost, Feed, and GH PR Status each have a short narrated demo.
The videos are GitHub attachments, uploaded to
[issue #10](https://github.com/ZackarySantana/opcode/issues/10): GitHub plays a
`github.com/user-attachments/assets/…` URL inline when it sits on its own line,
but only links committed video files. Keep that issue: deleting it may remove them.
The root README embeds them that way. Package READMEs, which npm renders without
video, show `<plugin>-demo.jpg` instead (1280 by 720, with a play button), linked
to the same attachment, which plays in the browser.

Each video replays a real OpenCode 2.1.3 terminal session, recorded through a
pseudo-terminal with the unmodified plugin loaded under a temporary HOME, then
composed with captions, key caps, camera moves, narration (ElevenLabs), and
synthesized music. The terminal content is not redrawn. The data is not real:

- **Sessions, projects, people, and pull requests** are fixtures, named after the
  fictional `aurora-web`, `ledger-api`, and `docs-site` projects.
- **Feed** reads sample Statuspage and GitHub release feeds served for the
  preset URLs by a local proxy. Its Claude and GitHub incidents are illustrative,
  not real outages.
- **GH PR Status** reads a stand-in `gh` that returns sample pull requests.
- **Later** and **GH PR Status** show agent replies from a scripted stand-in for
  the Anthropic Messages API; the tools they call (`later_add`, `read`) run for
  real. No other model requests were made.
- **Cost** reads a ledger seeded with a month of illustrative usage at list
  prices; **Context** reads a generated session with large tool outputs.

The masters are 1080p at 30 fps; the uploaded copies are re-encoded at CRF 30
(about 1 Mbit/s, 3 to 6 MB each, under GitHub's 10 MB attachment limit).
