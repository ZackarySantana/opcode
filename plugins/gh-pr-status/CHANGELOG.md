# @lidtop/opencode-gh-pr-status

## 0.3.0

### Minor Changes

- e44fa40: Add an OpenCode Desktop part: a pill above the composer listing the pull requests waiting on you (open one in the browser, or refresh when they can't be read), **Pull requests** (`/ghpr`) to search every pull request grouped as the terminal's tabs, **Refresh pull requests**, and **Send PR review comments** (`/ghpr-comments`), which puts the review comments into the session's composer for you to review and send.
- 62c9603: Require OpenCode 2.2.0 and OpenTUI 0.7.

## 0.2.3

### Patch Changes

- 915e7ff: A new **Ignore inactive** setting (Off, 7 days, 14 days, 1 month, 3 months, 1 year) leaves a pull request out of `/ghpr` and the sidebar once it has gone that long without activity on GitHub, such as a push, comment, review, or review request. It defaults to 1 month.
- 5ccffe8: GH PR Status now runs on the OpenCode server, so every terminal connected to it shows the same pull requests and settings, and GitHub is polled once for all of them instead of once per terminal. A change to a setting or the Teams tab's filter, or a refresh with `r`, shows in every terminal right away, and the sidebar's countdown follows the server's schedule. Configure the plugin where the server reads plugins (`opencode.json(c)`, not `cli.json`), with `gh` installed and signed in on the server's machine; without the server side, the sidebar and `/ghpr` say to add it; `/ghpr-comments` reads the session's branch there too. `commentsPrompt` is now a server option, and the `database` option is gone: settings live in the server's plugin storage. If the server can't read the saved settings, it shows the defaults and refuses changes until it can, rather than overwrite them. Settings saved by earlier versions are not carried over and start at the defaults; you can delete `opcode-gh-pr-status/gh-pr-status.sqlite` in the terminal's OpenCode state directory.
- e91635a: Shared code that Feed and GH PR Status use moved into helpers every plugin bundles: the minute clock that ages views, and sending changes to the server in order while showing them at once. Nothing changes for any plugin.

## 0.2.2

### Patch Changes

- 31ba0af: Pull requests are ordered by when they came to you, not GitHub's last update, and a new **Order** setting (Smart, Newest, Oldest) chooses how. Smart, the default, puts pull requests that need your eyes first: review requests for you by name, and your own pull requests where a reviewer commented or requested changes and you haven't requested their review again since. The rest follow, both parts oldest first. The sidebar is one list in that order and now includes all your open pull requests. Each pull request shows the time it sorts by: when your review, or your team's, was requested; when a reviewer first asked for changes to yours; otherwise when it opened. A reviewer's comments on your pull request now mark it **Review comments**, and requested changes clear once you request that reviewer again. Settings saved by earlier versions can't be read: delete `opcode-gh-pr-status/gh-pr-status.sqlite` in OpenCode's state directory before upgrading.

## 0.2.1

### Patch Changes

- e5df44d: The README opens with a short demo video.

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
