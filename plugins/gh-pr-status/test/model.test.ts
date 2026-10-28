import { expect, test } from "bun:test"
import { fetchSnapshot, parseResponse, type Runner } from "../src/gh"
import { defaultSettings, HIDDEN_TEAM, sidebarEntries, view, type Order, type Snapshot } from "../src/model"
import { NOW, pr, response, team, teams, user } from "./fixtures"

const snapshot: Snapshot = { ...parseResponse(response, ""), teams: ["acme/web", "acme/api"] }
const summary = (entries: readonly { label: string; pr: { number: number }; teams: readonly string[] }[]) => entries.map((entry) => [entry.pr.number, entry.label, entry.teams])
const numbers = (entries: readonly { pr: { number: number } }[]) => entries.map((entry) => entry.pr.number)
const searches = (requested: unknown[], reviewed: unknown[], mine: unknown[] = []) =>
  JSON.stringify({ data: { viewer: { login: "me" }, mine: { nodes: mine }, requested: { nodes: requested }, reviewed: { nodes: reviewed } } })

test("your pull requests show what blocks them first; review requests split into yours, your teams', and teams your token can't see", () => {
  const current = view(snapshot)
  // Conflicts outrank failing checks, and approval waits on you to merge.
  expect(summary(current.mine).map(([number, label]) => [number, label])).toEqual([[1, "Conflicts"], [2, "Approved"], [3, "Draft"], [4, "Awaiting review"]])
  // A pull request requesting you and your team is yours to review, and also your team's. Teams you're not on drop out.
  expect(summary(current.reviewing)).toEqual([[10, "Review requested", ["acme/web"]], [20, "You approved", []], [21, "You commented", []]])
  expect(summary(current.teams)).toEqual([[10, "Review requested", ["acme/web"]], [11, "Team: web", ["acme/web"]], [12, "Team: api", ["acme/api"]], [13, "Team review", [HIDDEN_TEAM]]])
})

test("the sidebar lists what waits on you and all your open pull requests, as one list, narrowed by the team filter", () => {
  const current = view(snapshot)
  const listed = (settings: Partial<typeof defaultSettings>) => numbers(sidebarEntries(current, { ...defaultSettings, ...settings }))
  // Your request by name first, then by when each came to you; drafts and ones waiting on reviewers are yours too.
  expect(listed({})).toEqual([10, 1, 13, 2, 3, 4, 12, 11])
  expect(listed({ team: "acme/web" })).toEqual([10, 1, 2, 3, 4, 11])
  expect(listed({ sidebarTeams: false, sidebarMine: false })).toEqual([10])
})

test("smart puts requests for you by name and reviewers' comments on yours first, then the rest, each oldest first", () => {
  const web = (hours?: number) => [{ reviewer: team("acme/web"), hours }]
  const current = view({ ...parseResponse(searches(
    [
      pr(10, "Add REST route", { author: "alice", requested: web(135) }),
      pr(11, "Quarantine context", { author: "bob", requested: web(1) }),
      pr(12, "Full clone fallback", { author: "carol", requested: web(67) }),
      pr(14, "Stream logs", { author: "erin", requested: [{ reviewer: user("me"), hours: 50 }] }),
      pr(15, "Trim the bundle", { author: "erin", requested: [{ reviewer: user("me"), hours: 4 }] }),
    ],
    [],
    [
      pr(1, "Merge via CLI", { conflicts: true, opened: 6_000 }),
      pr(2, "Status check", { opened: 3, reviews: [{ author: "alice", state: "COMMENTED", hours: 2 }] }),
      // From the first review still asking for changes.
      pr(3, "Retry uploads", { opened: 200, reviews: [{ author: "bob", state: "CHANGES_REQUESTED", hours: 30 }, { author: "carol", state: "COMMENTED", hours: 90 }] }),
      // Requested again, the reviewer is back to reviewing.
      pr(4, "Pin the toolchain", { opened: 10, requested: [{ reviewer: user("dave"), hours: 5 }], reviews: [{ author: "dave", state: "CHANGES_REQUESTED", hours: 20 }] }),
      // Bots' reviews and your own replies don't count.
      pr(5, "Split the worker", { opened: 40, reviews: [{ author: "copilot", state: "COMMENTED", hours: 1, bot: true }, { author: "me", state: "COMMENTED", hours: 1 }] }),
    ],
  ), ""), teams: ["acme/web"] })
  expect(current.mine.map((entry) => [entry.pr.number, entry.label, entry.since.event])).toEqual([
    [1, "Conflicts", "opened"], [2, "Review comments", "reviewed"], [3, "Changes requested", "reviewed"], [4, "Awaiting review", "opened"], [5, "Open", "opened"],
  ])
  const listed = (order: Order) => numbers(sidebarEntries(current, { ...defaultSettings, order }))
  expect(listed("smart")).toEqual([3, 14, 15, 2, 1, 10, 12, 5, 4, 11])
  // By time alone.
  expect(listed("newest")).toEqual([11, 2, 15, 4, 5, 14, 12, 3, 10, 1])
  expect(listed("oldest")).toEqual([1, 10, 3, 12, 14, 5, 4, 15, 2, 11])
})

test("a review request you've reviewed since no longer waits on you, though GitHub's search or a team still lists it", () => {
  const approved = { review: { state: "APPROVED", hours: 1 } }
  const current = view({ ...parseResponse(searches(
    [
      // The author re-requested you; you approved, and the search hasn't caught up.
      pr(30, "Retry flaky uploads", { author: "alice", requested: [{ reviewer: user("bob"), hours: 2 }], ...approved }),
      // A required team keeps its request after you approve for it.
      pr(31, "Pin the toolchain", { author: "bob", requested: [{ reviewer: team("acme/web"), hours: 5 }], ...approved }),
      // Your team was requested again after you commented.
      pr(32, "Split the worker", { author: "carol", requested: [{ reviewer: team("acme/web"), hours: 1 }], review: { state: "COMMENTED", hours: 3 } }),
      // The author re-requested you after you approved.
      pr(33, "Stream logs", { author: "dave", requested: [{ reviewer: user("me"), hours: 1 }], review: { state: "APPROVED", hours: 3 } }),
      // Your team's request cleared when you approved; another team's remains.
      pr(34, "Trim the bundle", { author: "erin", requested: [{ reviewer: team("acme/design"), hours: 5 }], ...approved }),
    ],
    [
      pr(30, "Retry flaky uploads", { author: "alice", requested: [{ reviewer: user("bob"), hours: 2 }], ...approved }),
      pr(31, "Pin the toolchain", { author: "bob", requested: [{ reviewer: team("acme/web"), hours: 5 }], ...approved }),
    ],
  ), ""), teams: ["acme/web", "acme/api"] })
  expect(summary(current.reviewing)).toEqual([[33, "Review requested", []], [30, "You approved", []], [31, "You approved", []]])
  expect(summary(current.teams)).toEqual([[31, "You approved", ["acme/web"]], [32, "Team: web", ["acme/web"]], [34, "You approved", [HIDDEN_TEAM]]])
  expect(sidebarEntries(current, defaultSettings).map((entry) => [entry.pr.number, entry.label])).toEqual([[33, "Review requested"], [32, "Team: web"]])
})

test("ignoring inactive pull requests leaves out every one with no activity in that long, however long ago it opened", () => {
  const days = (count: number) => count * 24
  const searched: Snapshot = { ...parseResponse(searches(
    [
      pr(10, "Cache build artifacts", { author: "alice", updated: days(3), requested: [{ reviewer: user("me"), hours: days(3) }] }),
      pr(11, "Speed up CI", { author: "bob", updated: days(20), requested: [{ reviewer: team("acme/web"), hours: days(20) }] }),
    ],
    [pr(20, "Docs for webhooks", { author: "erin", opened: days(200), updated: days(100), review: { state: "APPROVED", hours: days(100) } })],
    [
      pr(1, "Fix login redirect", { opened: days(400), updated: days(10) }),
      pr(2, "Add dark mode", { opened: days(400), updated: days(400) }),
    ],
  ), ""), teams: ["acme/web"] }
  const listed = (ignoreDays: number) => {
    const lists = view(searched, ignoreDays, NOW)
    return { mine: numbers(lists.mine), reviewing: numbers(lists.reviewing), teams: numbers(lists.teams) }
  }
  expect(listed(7)).toEqual({ mine: [], reviewing: [10], teams: [] })
  expect(listed(14)).toEqual({ mine: [1], reviewing: [10], teams: [] })
  expect(listed(30)).toEqual({ mine: [1], reviewing: [10], teams: [11] })
  expect(listed(365)).toEqual({ mine: [1], reviewing: [10, 20], teams: [11] })
  expect(listed(0)).toEqual({ mine: [1, 2], reviewing: [10, 20], teams: [11] })
})

test("gh's own message explains a failure, and results GitHub withheld are counted", async () => {
  const unauthenticated: Runner = async () => ({ stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login\n", status: 4 })
  await expect(fetchSnapshot(unauthenticated, new AbortController().signal)).rejects.toThrow("Not signed in to GitHub. Run gh auth login.")
  expect(() => parseResponse(JSON.stringify({ errors: [{ message: "Bad credentials" }] }), "")).toThrow("Bad credentials")
  // Partial data arrives with a nonzero exit; the team list is optional.
  const partial: Runner = async (args) => args.includes("graphql") ? { stdout: response, stderr: "gh: Resource protected", status: 1 } : { stdout: teams, stderr: "", status: 1 }
  const result = await fetchSnapshot(partial, new AbortController().signal)
  expect(result.teams).toEqual([])
  expect(result.requested).toMatchObject({ hidden: 1, reason: expect.stringContaining("single sign-on") })
  expect(result.mine.hidden).toBe(0)
})
