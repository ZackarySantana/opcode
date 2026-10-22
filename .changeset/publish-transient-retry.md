---
---

Retry npm publishes after transient registry 5xx or network failures, re-checking the exact version first so a publish that landed is never repeated. Release tooling only; no package version bump.
