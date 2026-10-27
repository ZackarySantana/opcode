# Architecture

## Ownership

| Plugin | Domain data | Host adapter | Presentation |
| --- | --- | --- | --- |
| Context | Recorded telemetry and observable retained-context estimate | Public history/context/catalog reads; read-only tool RPC | Session dialog and explicit metadata export |
| Cost | Normalized usage ledger and date/entity aggregates | Server-owned SQLite, live events, RPC; client history import | Overview/Models/Projects/Daily/Turns dialog with a date picker |
| Later | Ordered active items, completed history, and settings | Client-local SQLite, also opened by server-side agent tools; isolated prompt-paste bridge | Later/History/Settings dialog, native edit/confirmation dialogs, sidebar |
| Sessions | Searchable user/assistant text and session metadata; active sessions projected from server state | Server-owned SQLite, live events, RPC; client history import; client-side snapshot plus live events for active sessions | Browser, filters, preview, active-sessions sidebar, `/go` |
| Feed | Subscriptions, settings, and an interpreted timeline of feed items | Client-local SQLite, feed fetching | Status/Upcoming/Releases/Subscribe/Settings dialog, feed picker, sidebar |
| GH PR Status | Pull requests classified by what waits on you, settings, and a saved team filter | Client-local SQLite, `gh` GraphQL and REST calls | Mine/Reviewing/Teams/Settings dialog, team picker, sidebar |
| Snippets | Global and project snippet files, precedence, and `@name` mentions | Server-owned files, skill registration, prompt/context hooks, authoring tools, RPC | Dialog with previews, prompt paste bridge, authoring sessions |
| Media | Project-relative output paths, image naming, PCM-to-WAV framing | OpenRouter media API with the `openrouter` integration credential; agent tools | None: server-only agent tools |
| Review | Patch rows and segments, line comments that follow their text, delivery states, viewed-by-patch-hash, the review message, names and definitions per language, usages arranged against the diff | Host session/VCS diffs and inbox; synced terminal storage; server plugin storage, prompt/context hooks, a reply tool, RPC; language servers from OpenCode's `lsp` config in a server-side pool, ripgrep / `git grep` | Session panel with the file tree or paths and the diff, inline comment editor, usages list, read-only file view, options menu, sidebar |

Later is deliberately not an execution engine: starting an item pastes it into
the existing prompt, without submission. Its server side only registers agent
tools on its SQLite file, resolved the same way on the server's machine, so they
reach the terminal's list only with a local server; deleting asks for permission.
Cost is recorded message telemetry,
not an invoice. Context estimates visible retained content, not the exact hidden
provider payload. Sessions stores conversation text; treat its database as
sensitive. Snippets registers each snippet as a user-only skill
(`autoinvoke: false`), so `@name` uses the host's attachment path, and a prompt
hook attaches `@name` text that was pasted rather than picked from completion;
its writing tools exist only in sessions it marks for authoring, and every write
asks for permission. Media reads the `openrouter` integration credential for each
call rather than going through the provider, so a policy that denies the
OpenRouter provider leaves its tools working; it checks the tool/model and `edit`
permissions before spending anything, and writes only inside the project.
Review sends all drafts as one steering prompt under a host-format message ID it
generates and stores first, so a retry after an uncertain failure returns the
original admission instead of a second message; a declared refusal returns the
comments to drafts. Its prompt hook records the comment IDs a
message carried; the `review_reply` tool exists only in sessions with such a
record, and accepts only those IDs. Comments live in synced terminal storage,
replies in server plugin storage, read back over RPC. For usages, the terminal reads
OpenCode's merged `lsp` config (the server plugin context has no config API) and
passes it with each lookup; the server validates it and starts that language
server in the caller's location, in a pool keyed by directory and server and
disposed with the plugin. A client choosing the command doesn't widen what it can
do: OpenCode clients can already run shells through the API.

## Shared code

`@opcode/ui` owns the original-style Page, Card, StatCard, FilterChip, KeyHints,
and CenterEmpty components. All plugins compose these same semantic surfaces,
rather than maintaining their own header, panel, and footer styling.
OpenCode remains responsible for actual rendering, sizing, and native dialogs.
Terminal-cell measurement and grapheme-safe truncation are shared here too;
`useText()` binds them to the host renderer's width method, so wide labels
behave consistently across Context, Cost, and Sessions.

The shared palette reads the active V2 theme, not fixed RGB colors. Page/dialog
titles, sidebar titles, and shortcut keys use normal `text.base` (not literal
white). Labels and descriptions use `text.muted`; borders use `border.base`.
Accent hue 300 is reserved for section headings and chart fills; interactive hue
300 gives metrics a contrasting tone. Hue steps follow the theme's light/dark
contrast direction. Selection uses the paired action foreground/fill, never an
accent-colored label over a selected background. Feedback statuses retain their
semantic tokens. Empty chart tracks stay neutral, and cost activity does not
imply success or warning. `ThemeSurface`
keeps Context's shared cards and hints on the resolved dialog surface. Palette
reads stay reactive, including when an open view changes theme or mode. A theme
with neutral accent/interactive aliases intentionally remains monochrome.

`@opcode/ui/paste` is the prompt paste bridge Later and Snippets share: it
returns to a home or session prompt, waits for its paste command, and pastes
through OpenTUI without submitting.

`@opcode/ui/screen` shares immutable route snapshots and component-owned dialog
commands. Context and the dialog plugins (Cost, Feed, GH PR Status, Later,
Sessions, Snippets) register commands with it: native dialogs already own the
`modal` input mode, so plugins must not push a competing route mode.
Tab pills and actionable keyboard hints invoke the same commands/state
transitions from mouse input. The host's `router.current()`
is a live store proxy, never a safe value to save directly as a return destination.
Persistence, domain actions, and their cancellable I/O remain plugin-specific.

`@opcode/tabs` holds what Feed, GH PR Status, and Later share: the tabbed dialog with one
search box and Escape that undoes one step at a time, grouped item cards that
open on enter or click, the picker, the Settings tab, sidebar items with "+N
more" lines, the refresh countdown beside a section title, the refresh schedule, and the browser
launcher. Sessions uses its dialog, picker, and sidebar items too, Cost its tabbed
dialog and picker, Snippets its tabbed dialog and item cards, and Review its sidebar click. Native prompts
replace a custom dialog, so Later passes its own tab and focus signals, and Snippets
its focus signal, to come back on the same tab and item. It is a separate workspace so
that changing it releases only its consumers, not every consumer of `@opcode/ui`.

`@opcode/core` contains small host-independent utilities, including the XDG
state directory and owner-only WAL SQLite setup shared by Cost, Later, and
Sessions. Domain models stay in
their plugin. Share recurring behavior after it appears, rather than building a
general plugin framework or repository abstraction.

## Dependencies and releases

The Bun workspace catalog pins the OpenCode SDK family together. A named host
catalog centralizes compatible peer ranges separately from development pins; each
range's lower bound must equal its development pin, and bundles must declare
these host singletons as peers rather than ship their own copies.
Private workspace source is bundled into each package. Host runtimes and all
third-party dependencies stay external.

The public npm packages are `@lidtop/opencode-context`, `@lidtop/opencode-cost`,
`@lidtop/opencode-later`, `@lidtop/opencode-sessions`, `@lidtop/opencode-feed`, `@lidtop/opencode-gh-pr-status`, `@lidtop/opencode-snippets`, `@lidtop/opencode-media`, and `@lidtop/opencode-review`. Each has its own version
and changeset history; they are not a permanent lockstep group. The npm scope does not rename runtime plugin, command,
or RPC IDs, nor existing database paths. Shared-source or
catalog updates require releases of affected consumers, not a forced permanent
lockstep version. Build and publication operate on self-contained staged
artifacts; private workspace names must never reach npm as dependencies.

## Review gates

1. **Design:** composability, common UI, minimal styling surface, no speculative
   abstractions.
2. **Correctness:** observable behavior, ownership, concurrency, cleanup,
   cancellation, simple testable boundaries.
3. **Tests:** prioritize regressions and user behavior; remove checks that merely
   freeze source text, compiler output, or incidental implementation choices.

Run `mise run check` before release. Automated tests do not substitute for an
interactive OpenCode smoke test; see [migration notes](migration.md).
