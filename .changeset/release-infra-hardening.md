---
---

Harden release infrastructure: only changesets added or edited by a change cover it, host singleton pins must match their peer floors, builds reject bundled host singletons without peer declarations, and publishing moves to an unprivileged validate job plus an OIDC job that publishes the validated prebuilt tarballs. Repository tooling only; no package version bump.
