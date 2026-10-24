# @lidtop/opencode-gh-pr-status

Never leave a review waiting. See the GitHub pull requests that need you in the sidebar, with your pull requests, your reviews, and your teams' review requests one command away.

## Install

Requires OpenCode **2.1.3 or newer in the 2.x line**, and the [GitHub CLI](https://cli.github.com/) signed in with `gh auth login`.

```sh
opencode plugin add @lidtop/opencode-gh-pr-status
```

Or add it to `plugins` in your global `~/.config/opencode/opencode.jsonc` (or `opencode.json`), keeping your existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-gh-pr-status"]
}
```

**Where it runs.** This is a terminal UI plugin; its server entrypoint does nothing. You can instead put the same entry in global `~/.config/opencode/cli.json` to load it on the client only, independent of server configuration. **Do not configure both.** The terminal client runs `gh` and stores your settings on its filesystem, including when connected to a remote server, so `gh` must be installed and signed in where you run OpenCode.

## Use

Run `/ghpr` or select **Pull requests** in the command palette. The dialog has four tabs:

- **Mine:** your open pull requests. The ones that need you come first, then the ones waiting on others, then drafts.
- **Reviewing:** pull requests requesting your review by name, then open ones you've already reviewed. Requests only for your teams are on Teams.
- **Teams:** review requests for your teams, ones that also request you first, with every requested reviewer listed. Press `f` to show one team; the choice is saved until you pick **All your teams** there.
- **Settings:** what the sidebar shows, and how often it refreshes.

Each pull request shows its status, author, repository and number, when it was opened, and who is requested and when: you first, then your teams, then everyone else.

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | Next / previous tab |
| `↑` / `↓`, `j` / `k` | Move the outline |
| `/` | Search titles, authors, repositories, statuses, and reviewers |
| `enter`, `space` | Open the outlined pull request in your browser (clicking one does too) |
| `f` | Show one team's review requests, or all of them (Teams) |
| `←` / `→`, `h` / `l` | Change the outlined setting (Settings) |
| `r` | Refresh now |
| `esc` | Leave the box, clear the search, close the team picker, then close |

A pull request **waits on you** when:

- it requests your review, or your team's, and you haven't reviewed it since (GitHub can keep a team's request after you review, such as one a ruleset requires);
- it's yours and has merge conflicts, failing checks, or requested changes, or is approved and ready to merge.

Statuses are colored by urgency: red for your pull requests that are blocked, yellow for review requests (**Review requested** for you, **Team: web** for your team), green for approved, the theme's highlight for pull requests waiting on someone else, and gray for drafts and pull requests you've approved or commented on.

The sidebar lists only what waits on you: review requests for you first, then your teams' (narrowed to the team chosen on the Teams tab), then your own pull requests that need you. Each shows how long ago your review was requested, or for your own, how long ago it opened. It lists five by default, then a count of the rest and a pointer to `/ghpr`, and ends with a countdown to the next refresh. Click a pull request there to open it in your browser, or the "+N more" line to open `/ghpr`.

Links open in your browser with `open` (macOS), `rundll32` (Windows), or `xdg-open` (Linux); on WSL it tries `wslview`, `xdg-open`, then PowerShell.

## Send review comments to the agent

Run `/ghpr-comments` in a session (or select **Send PR review comments** in the command palette) to send the review feedback on the pull request for the branch checked out in the session's directory, as `gh pr view` finds it there; it stops if that pull request isn't open. It arrives as your prompt in that session: instructions to verify each comment against the code and come back with an action for it (reply why not, or change the code and what that changes), then the pull request and its comments, each anchored to its file and line with links.

It sends the unresolved review threads someone else started, with your replies in them, plus others' review summaries and pull request comments. It leaves out resolved threads, threads you started, your own review summaries and comments, pending reviews, and anything from bots. An outdated thread stays, marked with the line it was on and the end of its diff. Long comments are cut at 1,500 characters, a long thread keeps its first comment and last three replies, and the whole message stops at about 40,000 characters; the message and the toast count what was left out. When nothing is left, nothing is sent. It reads the first 100 threads, reviews, and comments, and the first 100 comments in a thread. It only reads from GitHub.

## Teams and hidden pull requests

Review requests come from GitHub's `review-requested:@me` search, which includes requests to any team you're on, closed and secret teams included, as long as `gh` can see them. Team names come from `gh api /user/teams`, which needs the `read:org` scope that `gh auth login` grants by default; without it, every team requested on a pull request that asks for your review is treated as yours.

GitHub sometimes withholds results. A pull request in an organization that enforces SAML single sign-on stays hidden until you authorize `gh`'s token for that organization, and a team your token can't see shows as **hidden team**. `/ghpr` counts what was withheld and says what to do, such as authorizing GitHub CLI for an organization's single sign-on at [github.com/settings/connections/applications](https://github.com/settings/connections/applications); the sidebar notes hidden review requests.

## Settings

| Setting | Choices | Default |
| --- | --- | --- |
| Sidebar team reviews | No, Yes | Yes |
| Sidebar own PRs | No, Yes | Yes |
| Sidebar items | 3, 5, 10, 15, 20 | 5 |
| Refresh every | 1m, 2m, 5m, 10m, 15m, 30m | 5m |

Review requests for you always appear in the sidebar. **Sidebar team reviews** adds your teams' review requests, narrowed to the Teams tab's filter; **Sidebar own PRs** adds your pull requests that need you. Each refresh runs one GraphQL search per list, up to 50 open pull requests each.

## Options

Load the plugin in global `~/.config/opencode/cli.json` to pass options; server-loaded terminal extensions in OpenCode 2.1.1 do not reliably receive server plugin options.

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    { "package": "@lidtop/opencode-gh-pr-status", "options": { "database": "/absolute/path/gh-pr-status.sqlite" } }
  ]
}
```

- `commentsPrompt`: the instructions `/ghpr-comments` sends before the comments. `{branch}` becomes the pull request's branch and `{pr}` its number. The default asks the agent to verify each comment, look at the bigger picture, and come back with an actionable item for each.
- `database`: where settings and the team filter are stored. Relative paths resolve from the client's `$XDG_STATE_HOME/opencode` (or `~/.local/state/opencode`), not the project directory. The default is `$XDG_STATE_HOME/opencode/opcode-gh-pr-status/gh-pr-status.sqlite` (or `~/.local/state/opencode/opcode-gh-pr-status/gh-pr-status.sqlite`).

## Data and privacy

The database stores your settings and team filter. Pull requests are kept in memory only. Requests go to GitHub through `gh`, with its credentials. `/ghpr-comments` sends the comments it reads to your session, and from there to your model provider, like any prompt; nothing else is sent.

## Development

From the repository root:

```sh
mise exec -- bun test plugins/gh-pr-status/test
mise exec -- bun run typecheck
mise run dev gh-pr-status
```

The build bundles the private `@opcode/core`, `@opcode/tabs`, and `@opcode/ui` workspaces into the package; OpenCode, OpenTUI, and Solid stay external.
