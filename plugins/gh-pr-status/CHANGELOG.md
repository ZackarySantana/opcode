# @lidtop/opencode-gh-pr-status

## 0.2.0

### Minor Changes

- dabd5c5: Add `/ghpr-comments`, which sends the open review feedback on the current branch's open pull request to the open session as your prompt, asking the agent to verify each comment and come back with an action for it. Resolved threads, bots, and your own threads, reviews, and comments are left out; outdated threads stay, marked with the line they were on. The `commentsPrompt` option replaces the instructions.

### Patch Changes

- e9e45a3: The sidebar no longer warns about review requests GitHub withheld; `/ghpr` still counts them and says what to do.
- bb097fd: Require OpenCode 2.1.3 or newer.
- 3c06421: Stop listing a review request as waiting on you once you've reviewed since it was made. A team request that GitHub keeps after your review (such as one a ruleset requires), or a request GitHub's search still lists after you approved, no longer appears in the sidebar; a request made again after your review still does. Your latest review is now read with `viewerLatestReview`, since `latestReviews` can leave it out.
- 1708674: Move Later's prompt paste helper into the shared UI package so Snippets can reuse it. No behavior changes.
- c1cfd3c: Clicking "+N more in /ghpr" or "+N more in /feed" in the sidebar now opens the dialog and keeps it open. Before, the dialog closed again as soon as the mouse button was released.
- 44bad65: The Pull requests and Feeds sidebar sections show their refresh countdown beside the title instead of on a line of their own. Those sections and Agents no longer add a line saying there's nothing to show; they show just the title.
- e85fab8: The shared tabbed dialog can keep its open tab when shown again, for Later. No behavior changes.
- f27f920: The shared item card can lead with its title when an item has no head, for Later. No behavior changes.

## 0.1.0

### Minor Changes

- 86148b3: Add GH PR Status: the GitHub pull requests waiting on you, in the sidebar, from the GitHub CLI. `/ghpr` lists your pull requests, the ones you review, and your teams' review requests with every requested reviewer, a saved team filter, and when each was opened and your review requested. Click or press `enter` to open one in your browser.
