# Review record

Independent subagents review each implementation from three perspectives.
This record distinguishes reviewed code from interactive host validation.

## Actual-host UI follow-up

The initial callback-based reviews missed a real host contract: `router.current()`
is a live mutable store proxy. Later saved that proxy as its return destination;
Escape dispatched correctly but returned to Later itself. The old flat visual
wrappers also failed to preserve the original plugins' design.

- Restored the original screenshot/source layouts: compact headers and keyboard
  hints, filter chips, raised bordered cards/panes, stacked statistics, contrasting
  selections, centered empty states, and anchored footers.
- Shared those actual visual primitives in `@opcode/ui`, removing the unused flat
  wrappers rather than retaining two competing design systems.
- Moved ownership, immutable return-route snapshots, open/back navigation,
  interaction invalidation, mode scopes, and command registration into
  `@opcode/ui/screen`. Later, Cost, and Sessions now use it; Context shares its
  input scope. The regression suite includes a mutable-store router, not just
  mocks that replace route objects. Snapshots copy mutable plain containers while
  preserving callback functions and opaque route handles, which the native host
  also permits.
- Real PTY input now exercises Later add/cancel/history/Escape/paste, Cost filter
  dialogs, Sessions search, and Context dismissal using the installed OpenCode
  host. This is separate from both callback unit tests and server/RPC activation.
- Real-host testing also exposed missing server-to-TUI option forwarding in
  OpenCode 2.1.1. The preview loads Later explicitly on the CLI side and verifies
  its temporary database is created while the legacy path remains untouched.
- A reference-size 92×38 Context render now shows activity values, provenance,
  both disclaimers, and keyboard hints without scrolling. Compact spacing is an
  option on the shared cards, not a separate Context-only design system.

## Subsequent UI/data regressions

- Cost no longer guesses its content height from terminal dimensions. Rendered
  empty-state tests cover wrapped headers and host-constrained heights, verifying
  no scrollbar or blank scroll range while retaining real overflow scrolling.
- Cost preserves mounted cards, values, and scroll position during same-query
  background updates, coalesces pending refreshes, and reports transient errors
  without replacing the page. Changed filters/locations still clear stale data.
- Context's tabs and legend actions now accept mouse input and use the same
  handlers as its keyboard commands. Native dialogs own their input mode; the
  shared dialog command helper no longer competes with that mode.
- Sessions explicitly omits absent optional identifiers at the SQLite-to-RPC
  boundary. The strict schema validates before JSON encoding, so an own property
  with `undefined` was not equivalent to an omitted key. Legacy SQL NULLs stay
  intact. A real host/typed-client test covers populated root and child rows.
- The PTY smoke uses a headless terminal grid, rather than concatenated ANSI
  deltas, and checks actual Context tab switching plus a populated Sessions row
  created through the public API. Tests use separate temporary databases only.

## Shared foundation (initial review)

- **Design:** no blocking findings. Removed the unused UI → core dependency;
  content primitives remain small, semantic, and caller-composed.
- **Correctness:** no actionable defects in the queue or shared UI ownership.
  Final artifact externalization is checked separately by packaging tests.
- **Test value:** retained the behavior/policy tests. Strengthened queue tests
  with a controlled pending operation, FIFO order, and per-caller results.
  Catalog checks now include root dependencies and resolved named catalogs.
  Added user-visible error normalization coverage, not formatting-wrapper tests.

## Build and releases

- **Design/correctness:** fixed a release-policy gap: changes in named catalog
  peer ranges and inherited runtime dependencies now require the affected public
  consumers' changesets. Development-only catalog updates do not force releases.
- **Test value:** packed fixtures now execute their RPC export and compile an
  isolated TypeScript consumer, including negative checks. Tests cover inherited
  runtime dependencies, independent versioning, safe dry runs, exact packed
  tarball publication, fail-closed registry errors, and partial-release retries.
- Documented release-PR workflow approval and npm trusted-publisher bootstrap.
  No live npm or GitHub release was performed.

## Context

- **Design:** no blocking issues; changed truncation to terminal-cell-aware,
  grapheme-safe sizing instead of JavaScript string length.
- **Correctness:** no actionable defects found. Retained-context failures stay
  visibly unavailable rather than becoming full-history estimates.
- **Test value:** strengthened constrained-dialog navigation/resize/shrink,
  exported-body exclusion, benign metadata preservation, loading provenance,
  nonexecuting tool RPC, and actual export-command guards/toasts.

## Later

- **Design:** no additional shared state/controller framework needed; the SQLite,
  selection, host, paste bridge, and presentation boundaries remain distinct.
- **Correctness:** replaced indefinite renderer-idle waiting with bounded,
  cancellable readiness/frame waiting. Route ownership checks both plugin ID
  and route name, preserving other plugins' same-name routes.
- **Test value:** added automatic cross-client polling/selection tests, real
  live-renderer readiness, independent controllers, advertised binding checks,
  zero-submission paste verification, and legacy-database writes/reopen checks.
  Paste acknowledgement and atomic cross-client claiming remain documented limits.

## Cost

- **Design/correctness:** filter interactions are scoped to a dashboard activation,
  so late lookups or selections cannot reopen a closed page or overwrite newer
  filters. Ownership includes plugin ID and route name. Mounted route data stays
  reactive rather than being captured by destructuring.
- **Persistence:** server-authorized project moves no longer make reconciliation
  fail or discard other records in the batch; live-write precedence persists.
  Inherited fork message IDs retain a single billed row without blocking new
  fork-only usage; parent-first and fork-first imports are covered.
- **Test value:** real OpenTUI tests cover narrow filtered daily activity,
  scrolling, query supersession, usage refresh, labels/totals, and unmount cleanup.
  Ledger tests cover legitimate updates as well as rejection of stale writes.

## Sessions

- **Design:** background host I/O no longer holds the index queue; bounded commits
  let searches/deletions proceed without permitting stale writes. Unicode sizing
  uses the shared helper, and compact session recency is restored.
- **Correctness:** dialogs are scoped to their browser invocation, owner checks
  include plugin ID/name, and reconnect reconciliation does not wait for the next
  event. Server identity and revision-bound upload checks remain intact.
- **Test value:** added idle reconnect, stale dialogs, matching before result
  limits, durable family tombstones/permissions, setup-level connection pinning,
  distinct rendered previews, and responsive background-sync regressions.

## Review

- **Design:** domain (patch rows, anchors, delivery, usages against the diff,
  names per language), adapters (diff sources, RPC, language-server pool, search),
  a controller that owns every write, and presentation stay separate. The message
  ID comes from the host's own generator rather than a copy of it.
- **Correctness:** a refresh no longer remounts an open comment box; an edit can't
  outlive its editor; one send per session at a time; declared refusals return
  comments to drafts. Lookups are effect-driven and answer the frame that asked,
  by ID, so closing, going back, or switching sessions can't strand a list. A
  name on a removed line is only ever searched for. Language servers report
  loading as progress; the first lookup waits for it, which a real
  typescript-language-server run confirmed (1 usage before, all 10 after).
- **Test value:** behavior through the panel with a reactive panel input and an
  asynchronous fake store; a fake language server with its own framing; real
  `git grep`; a terminal/server metadata contract test. The PTY smoke opens the
  panel and runs usages through the real RPC.

## Smoke-check safety

Correctness review found that inherited `OPENCODE_DB` could bypass temporary XDG
state, and external termination could leave a child running. The harness now sets
its database explicitly inside its temporary root and handles SIGINT/SIGTERM via
idempotent cleanup. Real subprocess regression tests verify both interruption
paths, database confinement, child termination, and temporary-state removal.

See [verification](verification.md) for manual checks distinct from automated
review. Built server exports have also been activated together in an isolated
OpenCode 2.1.1 process, including read-only Context, Cost, and Sessions RPC calls.

Latest automated gate: `mise run check` passed 230 tests, typechecking, and all four
builds. The isolated real-keyboard smoke passed all four screens with fresh,
screen-specific acceptance markers (not autocomplete titles). Package dry runs
remain non-publishing checks.
