import { expect, test } from "bun:test"
import { parseResponse } from "../src/gh"
import { pickable } from "../src/gui/actions"
import { en } from "../src/gui/i18n"
import { pillView, selectOptions, type Copy, type Shown } from "../src/gui/view"
import { defaultSettings, view, type Settings, type Snapshot } from "../src/model"
import { response } from "./fixtures"

/** The English copy, filled in as `ctx.t` and `ctx.plural` do. */
const copy: Copy = {
  t: (key, params = {}) => (en[key as keyof typeof en] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name])),
  plural: (key, count, params) => copy.t(`${key}.${count === 1 ? "one" : "other"}`, { ...params, count }),
}
const snapshot = { ...parseResponse(response, ""), teams: ["acme/web", "acme/api"] }
/** As `PullRequestsClient` shows a snapshot: inactive pull requests left out by the settings. */
const shown = (from: Snapshot | undefined, settings: Partial<Settings> = {}, error?: string): Shown => {
  const all = { ...defaultSettings, ...settings }
  return { snapshot: from, view: view(from, all), settings: all, error }
}
const loaded = (settings: Partial<Settings> = {}) => shown(snapshot, settings)

function actions() {
  const calls: string[] = []
  return { calls, actions: { open: (url: string) => calls.push(url), refresh: () => calls.push("refresh"), more: () => calls.push("more") } }
}

test("the pill counts what waits on you, colored by the most urgent, and its rows open each pull request", () => {
  const { calls, actions: run } = actions()
  const pill = pillView(loaded(), copy, run)!
  expect(pill).toMatchObject({ label: "6 pull requests waiting on you", tone: "danger", title: "Pull requests" })
  expect(pill.rows!.map((row) => [row.label, row.tone, row.detail])).toEqual([
    ["Cache build artifacts", "warning", "Review requested · web#10"],
    ["Fix login redirect", "danger", "Conflicts · web#1"],
    ["Rotate secrets", "warning", "Team review · web#13"],
    ["Add dark mode", "success", "Approved · web#2"],
    ["New billing API", "warning", "Team: api · web#12"],
    // The sidebar's five, then the rest.
    ["1 more in Pull requests", undefined, undefined],
  ])
  pill.rows![1]!.run!()
  expect(calls).toEqual(["https://github.com/acme/web/pull/1"])
})

test("past the sidebar's item count the pill points to the full list; without your PRs only reviews color it", () => {
  const { calls, actions: run } = actions()
  const pill = pillView(loaded({ sidebarItems: 3 }), copy, run)!
  expect(pill.rows!.map((row) => row.label).at(-1)).toBe("3 more in Pull requests")
  pill.rows!.at(-1)!.run!()
  expect(calls).toEqual(["more"])
  expect(pillView(loaded({ sidebarMine: false, sidebarTeams: false }), copy, run)).toMatchObject({ label: "1 pull request waiting on you", tone: "warning" })
})

test("no pill with nothing waiting; a failure shows one in danger, whose first row refreshes", () => {
  const { calls, actions: run } = actions()
  const empty = { ...snapshot, mine: { prs: [], hidden: 0 }, requested: { prs: [], hidden: 0 } }
  expect(pillView(shown(undefined), copy, run)).toBeUndefined()
  expect(pillView(shown(empty), copy, run)).toBeUndefined()
  const failed = pillView(shown(undefined, {}, "Not signed in to GitHub. Run gh auth login."), copy, run)!
  expect(failed).toMatchObject({ label: "Pull requests unavailable", tone: "danger" })
  expect(failed.rows).toEqual([expect.objectContaining({ label: "Not signed in to GitHub. Run gh auth login.", tone: "danger", detail: "Refresh" })])
  failed.rows![0]!.run!()
  expect(calls).toEqual(["refresh"])
  // The last snapshot stays listed under the error.
  expect(pillView(shown(snapshot, {}, "server gone"), copy, run)!.rows!.map((row) => row.label).slice(0, 2)).toEqual(["server gone", "Cache build artifacts"])
})

test("Pull requests lists everything grouped as the TUI's tabs are, narrowed to the saved team", () => {
  const groups = (state: Shown) => selectOptions(state, copy).map((option) => [option.group, option.title])
  expect(groups(loaded())).toEqual([
    ["Yours: needs you", "Fix login redirect"],
    ["Yours: needs you", "Add dark mode"],
    ["Yours: waiting", "Upgrade TypeScript"],
    ["Yours: drafts", "Refactor the router"],
    ["Awaiting your review", "Cache build artifacts"],
    ["Reviewed by you", "Docs for webhooks"],
    ["Your teams' review requests", "Cache build artifacts"],
    ["Your teams' review requests", "Rotate secrets"],
    ["Your teams' review requests", "New billing API"],
    ["Your teams' review requests", "Speed up CI"],
  ])
  expect(groups(loaded({ team: "acme/api" })).at(-1)).toEqual(["acme/api review requests", "New billing API"])
  // Ignore inactive leaves out what the TUI leaves out; off, the month-old review is back.
  expect(groups(loaded()).map(([, title]) => title)).not.toContain("Retire the v1 API")
  expect(groups(loaded({ ignoreDays: 0 }))).toContainEqual(["Reviewed by you", "Retire the v1 API"])
  expect(selectOptions(loaded(), copy)[4]).toEqual({
    title: "Cache build artifacts", description: "Review requested · @alice · acme/web#10", value: "https://github.com/acme/web/pull/10", group: "Awaiting your review",
  })
})

test("with nothing to pick, Pull requests says whether it's still loading or why it failed", () => {
  expect(pickable(shown(undefined), copy)).toEqual({ title: "Loading pull requests...", error: false })
  expect(pickable(shown(undefined, {}, "gh: not found"), copy)).toEqual({ title: "Pull requests unavailable", description: "gh: not found", error: true })
  const empty = { ...snapshot, mine: { prs: [], hidden: 0 }, requested: { prs: [], hidden: 0 }, reviewed: { prs: [], hidden: 0 } }
  expect(pickable(shown(empty), copy)).toEqual({ title: "No open pull requests", description: undefined, error: false })
  expect(pickable(loaded(), copy)).toHaveProperty("options")
})
