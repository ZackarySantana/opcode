---
"@lidtop/opencode-review": minor
---

New: `/diffs-guided` has the conversation's model walk you through the changes as a guided review. It orders them the way that explains them best, and each step puts the cursor on its lines with a note on what they do and what to look at. `n` and `p` move between steps, `esc` leaves the guide (or cancels it while it's being written), and `/diffs-guided` again resumes at the same step. Guides and questions share one helper session per reviewed session, so a question can ask about a step.
