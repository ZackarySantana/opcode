---
"@lidtop/opencode-gh-pr-status": minor
---

Add `/ghpr-comments`, which sends the open review feedback on the current branch's pull request to the open session as your prompt, asking the agent to verify each comment and come back with an action for it. Resolved threads, bots, and your own threads, reviews, and comments are left out; outdated threads stay, marked with the line they were on. The `commentsPrompt` option replaces the instructions.
