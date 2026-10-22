# Architecture

## Ownership

| Plugin | Domain data | Host adapter | Presentation |
| --- | --- | --- | --- |
| Context | Recorded telemetry and observable retained-context estimate | Public history/context/catalog reads; read-only tool RPC | Session dialog and explicit metadata export |
| Cost | Normalized usage ledger and date/entity aggregates | Server-owned SQLite, live events, RPC; client history import | Dashboard and native filters |
| Later | Ordered active items and completed history | Client-local SQLite and isolated prompt-paste bridge | Manager, native edit/confirmation dialogs, sidebar |
| Sessions | Searchable user/assistant text and session metadata | Server-owned SQLite, live events, RPC; client history import | Browser, filters, preview, safe resume action |

Later is deliberately not an execution engine: starting an item pastes it into
the existing prompt, without submission. Cost is recorded message telemetry,
not an invoice. Context estimates visible retained content, not the exact hidden
provider payload. Sessions stores conversation text; treat its database as
sensitive.

## Shared code

`@opcode/ui` owns the original-style Page, Card, StatCard, FilterChip, KeyHints,
and CenterEmpty components. All plugins compose these same semantic surfaces,
rather than maintaining their own header, panel, and footer styling.
OpenCode remains responsible for actual rendering, sizing, and native dialogs.
Terminal-cell measurement and grapheme-safe truncation are shared here too, so
wide labels behave consistently across Context and Sessions.

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

`@opcode/ui/screen` shares route ownership, immutable return-route snapshots,
open/update/back navigation, stale-interaction guards, mounted input modes, and
stable keymap registration. Later, Cost, and Sessions use the same controller;
Context uses the shared component-owned dialog commands instead: native dialogs
already own the `modal` input mode, so plugins must not push a competing route
mode. Tab pills and actionable keyboard hints invoke the same commands/state
transitions from mouse input. The host's `router.current()`
is a live store proxy, never a safe value to save directly as a return destination.
Persistence, domain actions, and their cancellable I/O remain plugin-specific.

`@opcode/core` contains small host-independent utilities. Domain models stay in
their plugin. Share recurring behavior after it appears, rather than building a
general plugin framework or repository abstraction.

## Dependencies and releases

The Bun workspace catalog pins the OpenCode SDK family together. A named host
catalog centralizes compatible peer ranges separately from development pins.
Private workspace source is bundled into each package. Host runtimes and all
third-party dependencies stay external.

The public npm packages are `@lidtop/opencode-context`, `@lidtop/opencode-cost`,
`@lidtop/opencode-later`, and `@lidtop/opencode-sessions`. Each has its own version
and changeset history; the current workspace versions are all `0.1.0`, not a
permanent lockstep group. The npm scope does not rename runtime plugin, command,
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
