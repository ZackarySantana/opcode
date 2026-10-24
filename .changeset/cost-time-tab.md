---
"@lidtop/opencode-cost": minor
---

Add a Time tab to `/cost`: agent working time per turn, time waiting on you (at most 30 minutes per wait), parallel time across root sessions with its peak, breakdowns by model/variant, project, and day, and the longest turns, which open their session. Delete the existing Cost database and its SQLite sidecars before upgrading; the history import rebuilds usage and backfills turn timing.
