# Builds and independent releases

The public packages are `opcode-context`, `opcode-cost`, `opcode-later`, and
`opcode-sessions`. Each has its own version and changelog. Changesets has no fixed
or linked groups. Private `@opcode/core` and `@opcode/ui` are never published.

Changesets' `privatePackages.version` is enabled only because CLI 2.31 rejects
public packages depending on skipped private packages. The release-policy check
rejects private-package changesets, private tagging is disabled, and private
versions remain unchanged. Consumer-only versioning is covered by an actual
Changesets CLI regression test.

## Local validation and artifacts

Use Bun and Node pinned in root `mise.toml` (the Bun version also appears in
`package.json`). CI and release jobs install this same mise toolchain:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run check
mise exec -- bun scripts/publish.ts --dry-run
```

`build` stages `.release/opcode-*/`. `publish.ts --dry-run` additionally uses local
`npm pack --ignore-scripts` to create actual npm tarballs in `.release/tarballs/`;
it neither queries nor writes to npm. Node 24 and npm are needed for packing tests.
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
- Omits dev dependencies and workspace scripts from published manifests.

Packaging tests unpack actual tarballs into an isolated directory. They resolve
every export and declaration import, verify private imports are gone, and inspect
source-map inputs to ensure no third-party runtime was bundled.

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
private-workspace dependencies. Dev-only catalog changes do not require releases.
All `@opencode/*` default catalog versions must move together. Plugin source or
runtime manifest changes also need their own changeset. Test-only changes do not.
Use patch/minor/major according to the public behavior, not the shared package's
unpublished `0.0.0` version. For example:

```md
---
"opcode-context": patch
"opcode-cost": patch
---

Fix the shared helper used by these two plugins.
```

CI checks this policy on PRs. The release PR consumes changesets, updates selected
versions/changelogs, and refreshes `bun.lock` with `scripts/version.ts`. Review
that PR's changed consumers; unrelated plugins retain their versions.

## GitHub and npm setup

1. Enable GitHub Actions and allow Actions to create pull requests. Protect `main`
   and require CI. Create the GitHub environment `npm`, restrict it to `main`, and
   preferably require maintainer approval. Release PRs created with `github.token`
   may need a maintainer to select **Approve workflows to run** before CI starts.
   For fully automatic release-PR CI, an appropriately scoped GitHub App token is
   optional; pass it to the Changesets action's `github-token` input instead.
2. Make sure each public package's `repository.url` exactly matches this GitHub
   repository. Repository metadata is copied unchanged into each staged manifest.
3. Bootstrap package ownership on npm if necessary. A brand-new package may need
   one initial authenticated/manual publish before its settings expose a trusted
   publisher. Use a locally packed artifact; do not put an initial-publish token
   into this workflow or commit credentials.
4. Configure **each package's** npm trusted publisher with the exact GitHub owner,
   repository, workflow filename `release.yml`, and environment `npm`. Allow
   direct `npm publish` (new configurations can default to staged publishing only).
   Follow npm's current validation/expiry requirements and perform the first
   authorized release promptly.
5. Once trusted publishing works, disallow token publishing and revoke bootstrap
   tokens. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` is used by this workflow.

The release workflow runs only on `main`. Its Changesets job can write release
PRs but has no OIDC permission. A separate GitHub-hosted, environment-gated publish
job has `contents: read` and `id-token: write`, but cannot write repository contents
or PRs. It uses pinned Node 24.22.0 and its bundled npm 11.19.1 (npm OIDC requires
at least 11.5.1), validates
everything, and publishes **the packed staged tarballs**, with provenance. It
fails closed on registry errors and skips exact versions already published, so
retries do not republish unrelated packages. The default local command only packs;
`--publish` additionally requires the main-branch GitHub OIDC environment.

This setup deliberately does not create GitHub releases or git tags: npm versions
and checked-in package changelogs are the release record. All workflow actions are
pinned to verified commit SHAs; update them deliberately. Release builds do not
restore dependency caches. No publish was performed during implementation.

References: [Changesets action v1](https://github.com/changesets/action/tree/maintenance/v1),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), and
[OpenCode V2 package entrypoints](https://opencode.ai/v2/docs/build/plugins/cli).
