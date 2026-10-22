import { expect, test } from "bun:test"
import { fetchSnapshot, parseResponse, type Runner } from "../src/gh"
import { defaultSettings, HIDDEN_TEAM, sidebarEntries, view, type Snapshot } from "../src/model"
import { response, teams } from "./fixtures"

const snapshot: Snapshot = { ...parseResponse(response, ""), teams: ["acme/web", "acme/api"] }
const summary = (entries: readonly { label: string; pr: { number: number }; teams: readonly string[] }[]) => entries.map((entry) => [entry.pr.number, entry.label, entry.teams])

test("your pull requests show what blocks them first; review requests split into yours, your teams', and teams your token can't see", () => {
  const current = view(snapshot)
  // Conflicts outrank failing checks, and approval waits on you to merge.
  expect(summary(current.mine).map(([number, label]) => [number, label])).toEqual([[1, "Conflicts"], [2, "Approved"], [3, "Draft"], [4, "Awaiting review"]])
  // A pull request requesting you and your team is yours to review, and also your team's. Teams you're not on drop out.
  expect(summary(current.reviewing)).toEqual([[10, "Review requested", ["acme/web"]], [20, "You approved", []]])
  expect(summary(current.teams)).toEqual([[10, "Review requested", ["acme/web"]], [11, "Team: web", ["acme/web"]], [12, "Team: api", ["acme/api"]], [13, "Team review", [HIDDEN_TEAM]]])
})

test("the sidebar lists only what waits on you: your reviews, your teams' (narrowed by the filter), then your pull requests", () => {
  const current = view(snapshot)
  const numbers = (settings: Partial<typeof defaultSettings>) => sidebarEntries(current, { ...defaultSettings, ...settings }).map((entry) => entry.pr.number)
  expect(numbers({})).toEqual([10, 11, 12, 13, 1, 2])
  expect(numbers({ team: "acme/web" })).toEqual([10, 11, 1, 2])
  expect(numbers({ sidebarTeams: false, sidebarMine: false })).toEqual([10])
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
