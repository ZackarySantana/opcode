# CI/release readiness audit — 2026-10-21

## Scope and boundaries

Audited against `../loadout/docs/opcode-release-handoff.md`. No new test cases,
temporary probes, dependencies, schemas, package versions, or release-policy
changes are part of this hardening. Validation uses existing checks and publisher
dry-runs only. The owner subsequently approved enabling Actions PR creation while
preserving default `read` permissions, and committing/pushing the four reviewed
hardening files. No PR merges, workflow dispatches, deployment approvals, or npm
publication are authorized or performed as part of this audit.

## Verified repository and remote runs

This directory initially had no Git metadata. During the audit, the owner
connected and pushed it. The confirmed origin is
`https://github.com/ZackarySantana/opcode.git`, with `main` at
`805bb5595e56e4dff599a8dbc8e0d39daeaf6e3b` (`feat: merge all plugins to opcode`).

| Check | Observed result |
| --- | --- |
| [Initial CI](https://github.com/ZackarySantana/opcode/actions/runs/39543431829) | Passed on the initial commit |
| [Initial Release](https://github.com/ZackarySantana/opcode/actions/runs/39543431777) | Failed opening the Changesets PR; publish job skipped |
| Failure annotation | `GitHub Actions is not permitted to create or approve pull requests` |
| Action runtime warning | Pinned mise action Node 20 deprecation warning; not the failure |
| Release branch | `changeset-release/main` exists at `111915dff9ed1afcd6f04850f10f72a4df67805d`; the failed run created its versioning commit before PR creation failed |
| Release PR | None exists yet |

The release branch changes the initial changeset, selected public package
versions/changelogs, and `bun.lock`. It has not been merged. This is remote
versioning output from the owner's initial push, not a local version bump made
by this audit.

## Existing fixture safeguards and local hardening

Opcode already bootstrapped its temporary parent in `test/setup.ts`, loaded first
by `bunfig.toml`. Both standalone smoke scripts also bootstrapped their parent.
The initial GitHub CI success independently confirms it did not suffer Loadout's
missing-parent failure.

The existing fixture factories and standalone scripts now use
`mkdtemp(join(tmpdir(), prefix))`/`mkdtempSync(...)`; existing bootstraps create the
selected OS temp parent rather than a harness-specific `/tmp/opencode`. Existing
test cases, path-security assertions, and owned-directory cleanup are unchanged.
Those portability changes were included in the owner's initial commit.

Remaining local workflow/documentation changes:

- Add supplementary CI `workflow_dispatch`, running the same checks and consumer
  release policy. It does **not** satisfy required PR checks under current GitHub
  rules; approve the actual bot-created `pull_request` run instead.
- Correct the pinned Changesets action's misleading manual-publication sentence
  after PR creation/update, preserving the rest of the generated body. This uses
  the existing version job PR-write token; no dummy publish input or OIDC grant.
- Document permission preflight, separate PR/deployment approvals, exact npm
  trusted-publisher fields, direct-publish permission, and the two-day validation
  window.

## Settings audit — read-only observations

| Setting | Observed value / remaining action |
| --- | --- |
| Actions enabled | `true` |
| Default workflow token | `read`; preserve this |
| Actions may create/approve PRs | Initially `false`; enabled after owner approval and re-read as `true`, with default token permission still `read` |
| `main` protection | Unprotected; no rulesets observed |
| `npm` environment | Missing (HTTP 404); owner must approve creation/protection |
| `npm` deployment branch policy | Cannot verify until the environment exists; allow/restrict to `main` |
| Repository Actions secrets | No names configured; no stored npm token required by this flow |

Do not broaden default token permissions. Repository/PR writes stay in `version`;
the separate publish job keeps `contents: read` and `id-token: write`. Required
reviewers on `npm`, if configured, create a separate deployment approval; the
agent must not approve that gate on the owner's behalf.

## npm preflight — not authenticated publication verification

The public registry returned HTTP 404 for all four unscoped package names:
`opcode-context`, `opcode-cost`, `opcode-later`, and `opcode-sessions`. Package
ownership/trusted-publisher settings are therefore not verified here. No live
publish or authentication test was attempted.

For every package, a maintainer must verify the exact publisher identity:

- GitHub owner/repository: `ZackarySantana` / `opcode`.
- Workflow filename: `release.yml`.
- Environment: `npm`.
- Allowed action: **Allow npm publish**, not stage-only access.
- No standalone `npm dist-tag` permission or stored npm write token needed.

New trusted-publisher configurations must make their first successful publication
within two days. Bootstrap ownership/configuration only around an explicitly
approved release; a dry run or skipped publish job proves no npm authorization.

## Validation and next approval gate

Validated a fresh clone of the confirmed GitHub `main` commit, with only the local
workflow/documentation patch applied. It had no pre-existing `node_modules` or
staged artifacts. Used the unchanged mise pins (Bun 1.4.3, Node 24.22.0), a frozen
lockfile installation with scripts disabled, and `TMPDIR` set to a newly created,
owned directory under the audit's temporary root. Shared `/tmp/opencode` was not
deleted or renamed.

- `mise run check`: **231 passed**, no failures; typechecking and all four builds
  passed. Existing packaging tests inspected standalone tarballs, exports/types,
  external runtime boundaries, and independent consumer release behavior.
- `bun scripts/release-policy.ts origin/main`: passed.
- `bun scripts/publish.ts --dry-run`: packed all four **0.1.0** artifacts without
  npm lookups or publication. Inspected each packed manifest: matching repository,
  concrete dependencies/peers, no private workspace protocols, and built exports.
- Frozen installation/checks/dry-run left package versions, `bun.lock`, release
  policies, and private-package configuration unchanged.
- Independent code review accepted the hardening with no actionable findings.
  The independent reviewer could not re-read the external handoff/GitHub CLI in
  its child environment; those sources and remote facts were verified directly
  by the coordinator. The changes and validation evidence were returned to the
  original handoff reviewer, who also accepted them with no actionable findings.

The owner approved the Actions PR-creation setting and the scoped hardening
commit/push. The setting was changed and verified without broadening default
permissions. The rollout must inspect the resulting CI and Release runs and
release PR; record commit/run/PR links in the handoff. Any `npm` environment/main
protection changes still require separate approval. Do not merge the release PR,
approve a deployment, or publish packages without explicit release approval.
