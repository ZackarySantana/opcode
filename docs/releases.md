# Builds and independent releases

The public packages are `@lidtop/opencode-context`, `@lidtop/opencode-cost`,
`@lidtop/opencode-later`, `@lidtop/opencode-sessions`, `@lidtop/opencode-feed`, `@lidtop/opencode-gh-pr-status`, `@lidtop/opencode-snippets`, `@lidtop/opencode-media`, and `@lidtop/opencode-review`. Each has its own version and
changelog. Changesets has no fixed or linked groups. Private `@opcode/core`, `@opcode/tabs`, and `@opcode/ui` are never published.
Each public manifest keeps `publishConfig.access: "public"`; scoped packages must
not fall back to npm's private-access default.

Changesets' `privatePackages.version` is enabled only because CLI 2.31 rejects
public packages depending on skipped private packages. The release-policy check
rejects private-package changesets, private tagging is disabled, and private
versions remain unchanged. Consumer-only versioning is covered by an actual
Changesets CLI regression test.

## Local validation and artifacts

Use Bun and Node pinned in root `mise.toml` (the Bun version also appears in
`package.json`). CI and release jobs install this same toolchain with a pinned,
checksum-verified mise release (see `jdx/mise-action` in the workflows):

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run check
mise exec -- bun scripts/publish.ts --dry-run
```

`build` stages `.release/opcode-*/`. `publish.ts --dry-run` additionally uses local
`npm pack --ignore-scripts` to create actual npm tarballs in a freshly emptied
`.release/tarballs/`; it neither queries nor writes to npm.
`publish.ts --pending --from <dir>` only reads the registry: it lists the tarballs
in `<dir>` whose exact `name@version` npm lacks (and writes them as the `packages`
GitHub step output). `--publish --from <dir>` publishes such prebuilt tarballs;
see below. Node 24 and npm are needed for packing tests.
Do not publish `plugins/*` directly: those workspace manifests contain
catalog/workspace protocols rather than standalone npm artifacts.

Each stage contains ESM JavaScript, linked source maps, declarations, a README,
root LICENSE, and an optional package changelog. The build:

- Exports `.` and `./tui`, plus `./rpc` when `src/rpc.ts` exists.
- Bundles the private workspaces, including shared JSX via the official
  `@opentui/solid/bun-plugin`. All third-party packages remain external, including
  every OpenCode, OpenTUI, and Solid subpath.
- Emits declarations with TypeScript; required private declarations are included
  in `dist/types`, and their private imports become relative local paths. A type
  error fails the build rather than advertising missing declarations.
- Merges runtime dependencies of bundled private workspaces, materializes catalog
  versions from the root catalog, and rejects unresolved local dependency specs.
- Fails if the bundle imports, or a manifest declares as a runtime dependency, a
  host singleton (any `catalogs.host` key) that the plugin does not declare in
  `peerDependencies`; it never silently ships an exact copy.
- Omits dev dependencies and workspace scripts from published manifests.

Packaging tests unpack actual tarballs into an isolated directory. They resolve
every export and declaration import, verify private imports are gone, and inspect
source-map inputs to ensure no third-party runtime was bundled.

### Historical: first manual 0.1.0 publication

This section records the completed initial bootstrap; later releases use the
automated flow below. For that initial manual bootstrap, do not run Changesets versioning first: it would propose a later
version. Build and pack with the non-publishing command, then authenticate in
your own terminal with an npm account authorized to publish under `@lidtop`:

```sh
mise exec -- bun scripts/publish.ts --dry-run
mise exec -- npm login --registry https://registry.npmjs.org/

mise exec -- npm publish .release/tarballs/lidtop-opencode-context-0.1.0.tgz --access public --ignore-scripts
mise exec -- npm publish .release/tarballs/lidtop-opencode-cost-0.1.0.tgz --access public --ignore-scripts
mise exec -- npm publish .release/tarballs/lidtop-opencode-later-0.1.0.tgz --access public --ignore-scripts
mise exec -- npm publish .release/tarballs/lidtop-opencode-sessions-0.1.0.tgz --access public --ignore-scripts
```

Each publish is independent; complete any browser/2FA prompts npm requires.
Publish these packed staged artifacts, **not `plugins/*`**. Scoped packages need
`--access public`. A local manual bootstrap does not use CI OIDC/provenance flags.
Afterward configure each package's trusted publisher as described below.

At the time, the initial Changeset represented the subsequent 0.2.0 proposal,
not the manual 0.1.0 bootstrap.

Fixture factories use `join(tmpdir(), prefix)` from `node:os`, including standalone
smoke entrypoints. The existing test preload and standalone bootstraps ensure
that the selected temp parent exists; they do not depend on `/tmp/opencode`.
To check portability, create a new owned temporary directory, set `TMPDIR` to it,
and run the existing checks. Never delete or rename a shared temp directory to
simulate a fresh runner. Cleanup must remain confined to each owned fixture.

## Choosing releases

```sh
mise exec -- bun run changeset
mise exec -- bun scripts/release-policy.ts origin/main
```

Select **public consumers**, not private workspace names. A `core`/`ui` source or
manifest change needs an explicit changeset for **every transitive consuming
plugin**. This is deliberate: Changesets cannot infer that private source is
bundled. Include the same consumer coverage when changing resolved runtime,
peer, or optional dependencies in any default or named catalog, including inherited
private-workspace dependencies. Changing a host singleton's default catalog pin requires a release of every
plugin that declares it as a peer. Each `catalogs.host` range must have the form
`>=<pin> <limit>`, whose lower bound equals the default catalog pin.
Dev-only catalog changes do not require releases.
All `@opencode/*` versions, default catalog and resolved references alike, must move
together. Plugin source or
runtime manifest changes also need their own changeset. Test-only changes do not.
Only changesets that the change itself **adds or edits** (committed or local
working-tree files since the merge base) count toward this coverage: an older
pending changeset for the same plugin describes a different change. Every pending
changeset is still validated; `scripts/version.ts` re-runs only that validation on
`main` before consuming them.
Use patch/minor/major according to the public behavior, not the shared package's
unpublished `0.0.0` version. For example:

```md
---
"@lidtop/opencode-context": patch
"@lidtop/opencode-cost": patch
---

Fix the shared helper used by these two plugins.
```

CI checks this policy on PRs. The release PR consumes changesets, updates selected
versions/changelogs, and refreshes `bun.lock` with `scripts/version.ts`. Review
that PR's changed consumers; unrelated plugins retain their versions.

After Changesets creates or regenerates the PR, the workflow updates its title
and publishing instructions together. Titles list only public plugins with a
proposed version different from the workflow's starting commit, in stable package
order, for example `chore(release): publish context@0.1.1 cost@0.2.1`. Every
package is included when every package changes. The private root/core/ui versions
never contribute, and release notes remain intact. This is a presentation change,
not approval to merge or publish; the npm environment protections and validation
still apply.

## GitHub and npm setup

### Repository preflight (read first; settings changes require owner approval)

Discover the actual target from a real checkout, rather than assuming package
metadata is current:

```sh
git remote get-url origin
gh repo view --json nameWithOwner --jq .nameWithOwner
```

If Git metadata is absent, confirm initialization and the target with the owner
before any push. Inspect existing CI/release runs, failed-job logs/annotations,
and release PRs. An empty repository has no remote checks to verify yet.

Read the Actions setting, using the confirmed `OWNER/REPO`:

```sh
gh api repos/OWNER/REPO/actions/permissions/workflow
```

If `can_approve_pull_request_reviews` is false, request permission to enable
**Allow GitHub Actions to create and approve pull requests**. Preserve the current
default token permission; do not broaden it to fix PR creation. After approval:

```sh
default_permissions=$(gh api repos/OWNER/REPO/actions/permissions/workflow --jq .default_workflow_permissions)
gh api --method PUT repos/OWNER/REPO/actions/permissions/workflow \
  -f default_workflow_permissions="$default_permissions" \
  -F can_approve_pull_request_reviews=true
gh api repos/OWNER/REPO/actions/permissions/workflow
```

This repository-level setting permits the operation; the `version` job separately
requests only its needed `contents: write` and `pull-requests: write`. OIDC remains
exclusive to the separate `publish` job. A mise action Node-runtime deprecation
warning is not a PR-permission or fixture failure; do not upgrade unrelated pins
as a workaround.

### Release-PR CI and publication instructions

Protect `main` and require the actual PR CI check from the expected GitHub App.
Release PRs created/updated with `github.token` can have approval-required
`pull_request` runs. A maintainer should select **Approve workflows to run** on
the PR, inspect the resulting CI run, and check the latest PR commit/test-merge
SHA. Changesets updates invalidate older results. A separately approved GitHub
App installation token can enable automatic PR events without this approval;
no App/token setup is added by these workflows.

For **supplementary validation only**, CI also supports manual dispatch:

```sh
gh workflow run ci.yml --repo OWNER/REPO --ref changeset-release/main
```

Use the release PR's actual head branch, not `main`, and ensure it contains the
updated workflow. Dispatch is available only after the workflow exists on the
default branch. Confirm the run's head SHA matches the reviewed PR head. Manual
CI runs the same checks **and affected-consumer policy**, using `main` as its base.
However, GitHub does **not** evaluate `workflow_dispatch` job checks as required
PR checks, even on that same SHA. Manual validation does not replace the approved
`pull_request` run, satisfy branch protection, or authorize bypassing it.

Changesets has no `publish` input here because publishing uses separate jobs. The
`version` job corrects only the pinned action's misleading manual-publication
sentence after each PR creation/update; it preserves the rest of the body and
changelog. The corrected instructions say that merging makes reviewed versions
eligible for automatic publication, subject to environment protections and
validation. Obtain explicit release approval **before merging**. Workflow-run
approval and deployment/release approval are different gates; never self-approve
a release on the maintainer's behalf.

### npm environment and trusted publishers

With owner approval, create/verify the GitHub environment **`npm`** and its branch
policy: it must permit `main` and should restrict publishing to that branch.
Inspect `repos/OWNER/REPO/environments/npm` and its `deployment-branch-policies`;
do not treat a workflow reference to the environment as proof it is configured.
Retain required reviewers where configured; a reviewer gate adds a separate
deployment approval. Environment changes require owner confirmation too.

Each public package needs its own npm trusted-publisher configuration:

| npm setting | Required value |
| --- | --- |
| Organization or user | `ZackarySantana` (GitHub owner, not npm scope `lidtop`) |
| Repository | `opcode` |
| Workflow filename | `release.yml` (not the display name or full path) |
| Environment | `npm` |
| Allowed action | **Allow npm publish** |

These values identify the actual GitHub origin, `ZackarySantana/opcode`; the npm
organization `@lidtop` is not the GitHub owner. Confirm the origin during preflight.
Check every package: `@lidtop/opencode-context`, `@lidtop/opencode-cost`,
`@lidtop/opencode-later`, `@lidtop/opencode-sessions`, `@lidtop/opencode-feed`, `@lidtop/opencode-gh-pr-status`, `@lidtop/opencode-snippets`, `@lidtop/opencode-media`, and `@lidtop/opencode-review`. Their staged `repository.url`
metadata must match the actual repository. Newly created trusted publishers can
default to stage-only access; that does not authorize this workflow's direct
`npm publish`. Standalone
`npm dist-tag` permission is unnecessary: this flow does not call it.

A new package may need an initial, separately authorized manual publish before
its npm settings expose trusted publishing. Bootstrap ownership only with release
approval and a packed staged artifact, never the workspace manifest. Do not add
bootstrap/write tokens to this workflow or commit credentials.

A new trusted-publisher configuration must complete its first successful publish
within **two days**, or it expires. Schedule configuration around an approved
release; never publish merely to test authentication. After an authorized OIDC
publish verifies the configuration, disallow traditional token publishing and
revoke bootstrap tokens. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` is used here.

Package settings are not proven by public registry metadata. A dry run,
`npm whoami`, successful PR creation, or a skipped publish job does **not** verify
npm trusted-publisher authentication. Report it as unverified until an explicitly
authorized publish succeeds.

The release workflow runs only on `main`, as three jobs:

1. `version` (Changesets) can write release PRs but has no OIDC permission.
2. `validate` has only `contents: read`. It runs the full check, packs the staged
   tarballs, uploads them as the `npm-tarballs` artifact, and outputs `packages`:
   the staged `name@version`s missing from npm (registry errors fail the job).
3. `publish` runs only when `packages` is non-empty, independently of whether
   changesets are pending. It is GitHub-hosted, environment-gated (`npm`), and has
   `contents: read` and `id-token: write`, but cannot write repository contents or
   PRs. It does not install dependencies, test, or build: it downloads the
   validated tarballs and runs `publish.ts --publish --from`, which requires exactly
   one tarball per public plugin, re-checks each exact version, skips published ones,
   and publishes the rest with provenance.

Publishing uses pinned Node 24.22.0 and its bundled npm 11.19.1 (npm OIDC requires
at least 11.5.1). It fails closed on registry errors and skips exact versions
already published, so retries do not republish unrelated packages. A publish that
fails with a registry 5xx or network error is retried twice (after 5s and 15s);
before each retry it re-checks the exact version, because a failed `PUT` may still
have landed. Auth, conflict, and validation errors are never retried. The default
local command only packs; `--publish` additionally requires the main-branch
GitHub OIDC environment.

This setup deliberately does not create GitHub releases or git tags: npm versions
and checked-in package changelogs are the release record. All workflow actions are
pinned to verified commit SHAs, and every `jdx/mise-action` step also pins the
mise `version` and the `sha256` of its Linux x64 binary; update them deliberately. Release builds do not
restore dependency caches. No publish was performed during implementation.

References: [Changesets action v1](https://github.com/changesets/action/tree/maintenance/v1),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), and
[OpenCode V2 package entrypoints](https://opencode.ai/v2/docs/build/plugins/cli).
See also [bot-token workflow approvals](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)
and [required-check event restrictions](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks).
