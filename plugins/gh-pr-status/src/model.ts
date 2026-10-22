import { matchesText } from "@opcode/tabs/format"

/** A requested reviewer: a user's login, or a team as "org/slug". Hidden when the token can't see who it is. */
export type Reviewer =
  | { readonly kind: "user" | "team"; readonly name: string; readonly requestedAt?: number }
  | { readonly kind: "hidden" }

export interface PullRequest {
  readonly url: string
  readonly number: number
  readonly title: string
  /** "owner/name". */
  readonly repository: string
  readonly author: string
  readonly draft: boolean
  readonly createdAt: number
  readonly conflicts: boolean
  readonly decision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED"
  readonly checks?: "passing" | "failing" | "running"
  readonly requested: readonly Reviewer[]
  /** The state of your latest review, such as "APPROVED". */
  readonly yourReview?: string
}

export interface Search {
  readonly prs: readonly PullRequest[]
  /** Results GitHub withheld, such as pull requests in SAML-enforced orgs, and why. */
  readonly hidden: number
  readonly reason?: string
}

export interface Snapshot {
  readonly viewer: string
  /** Your teams as "org/slug"; empty when gh can't list them. */
  readonly teams: readonly string[]
  readonly mine: Search
  /** Review requests for you or your teams. */
  readonly requested: Search
  /** Open pull requests you've reviewed, by others. */
  readonly reviewed: Search
}

/** Glyph and color follow the tone: urgent and attention need you, ready can be merged, the rest wait or recede. */
export type Tone = "urgent" | "attention" | "ready" | "waiting" | "quiet"

export interface Entry {
  readonly pr: PullRequest
  readonly label: string
  readonly tone: Tone
  /** Waiting on you: your review, or your action on your own pull request. */
  readonly pending: boolean
  readonly direct: boolean
  /** Your teams whose review is requested. */
  readonly teams: readonly string[]
  /** When your review, or your team's, was requested. */
  readonly requestedAt?: number
}

export interface Settings {
  /** Your pull requests that need you, in the sidebar. */
  readonly sidebarMine: boolean
  /** Review requests for your teams, in the sidebar, narrowed to `team` when set. */
  readonly sidebarTeams: boolean
  readonly sidebarItems: number
  readonly refreshMinutes: number
  /** The Teams tab's filter, as "org/slug". */
  readonly team?: string
}

export const defaultSettings: Settings = { sidebarMine: true, sidebarTeams: true, sidebarItems: 5, refreshMinutes: 5 }
export const sidebarItemChoices: readonly number[] = [3, 5, 10, 15, 20]
export const refreshChoices: readonly number[] = [1, 2, 5, 10, 15, 30]

/** A request GitHub matched to you without naming the team, which your token can't see. */
export const HIDDEN_TEAM = "hidden team"

function authored(pr: PullRequest): Entry {
  const entry = (label: string, tone: Tone, pending: boolean): Entry => ({ pr, label, tone, pending, direct: false, teams: [] })
  if (pr.draft) return entry("Draft", "quiet", false)
  if (pr.conflicts) return entry("Conflicts", "urgent", true)
  if (pr.checks === "failing") return entry("Checks failing", "urgent", true)
  if (pr.decision === "CHANGES_REQUESTED") return entry("Changes requested", "urgent", true)
  if (pr.checks === "running") return entry("Checks running", "waiting", false)
  if (pr.decision === "APPROVED") return entry("Approved", "ready", true)
  if (pr.decision === "REVIEW_REQUIRED" || pr.requested.length) return entry("Awaiting review", "waiting", false)
  return entry("Open", "waiting", false)
}

type Named = Extract<Reviewer, { name: string }>

/** A pull request GitHub says requests your review, directly or through one of your teams. */
function requested(pr: PullRequest, snapshot: Snapshot): Entry {
  const viewer = snapshot.viewer.toLowerCase()
  const direct = pr.requested.find((reviewer): reviewer is Named => reviewer.kind === "user" && reviewer.name.toLowerCase() === viewer)
  const visible = pr.requested.filter((reviewer): reviewer is Named => reviewer.kind === "team")
  const known = visible.filter((team) => snapshot.teams.includes(team.name))
  // Your team list narrows the visible teams to yours. When none match, the list is unavailable or incomplete, so any
  // of them may be yours; when none are visible, GitHub matched you through a team your token can't see.
  const teams = known.length ? known : visible
  const names = [...teams.map((team) => team.name), ...!direct && !teams.length ? [HIDDEN_TEAM] : []]
  const times = teams.flatMap((team) => team.requestedAt ?? [])
  return {
    pr, pending: true, direct: !!direct, teams: names, tone: "attention",
    label: direct ? "Your review" : "Team review",
    requestedAt: direct ? direct.requestedAt : times.length ? Math.max(...times) : undefined,
  }
}

function reviewed(pr: PullRequest): Entry {
  const entry = (label: string, tone: Tone): Entry => ({ pr, label, tone, pending: false, direct: false, teams: [] })
  if (pr.yourReview === "APPROVED") return entry("You approved", "quiet")
  if (pr.yourReview === "CHANGES_REQUESTED") return entry("You requested changes", "waiting")
  return entry("You commented", "quiet")
}

export interface View {
  readonly mine: readonly Entry[]
  /** Review requests for you, then pull requests you've reviewed. */
  readonly reviewing: readonly Entry[]
  /** Review requests for your teams, including ones that also request you. */
  readonly teams: readonly Entry[]
}

export function view(snapshot: Snapshot): View {
  const requests = snapshot.requested.prs.filter((pr) => pr.author !== snapshot.viewer).map((pr) => requested(pr, snapshot))
  const direct = requests.filter((entry) => entry.direct)
  const pending = new Set(direct.map((entry) => entry.pr.url))
  return {
    mine: snapshot.mine.prs.map(authored),
    reviewing: [...direct, ...snapshot.reviewed.prs.filter((pr) => !pending.has(pr.url)).map(reviewed)],
    teams: requests.filter((entry) => entry.teams.length),
  }
}

export const onTeam = (entries: readonly Entry[], team: string | undefined) => team ? entries.filter((entry) => entry.teams.includes(team)) : entries

/** Teams to filter by: yours, any requested of you, and the saved filter, so it can be cleared even once gone. */
export function teamChoices(snapshot: Snapshot, entries: readonly Entry[], saved: string | undefined): string[] {
  return [...new Set([...snapshot.teams, ...entries.flatMap((entry) => entry.teams), ...saved ? [saved] : []])].sort()
}

/** What waits on you, as the sidebar lists it: your review requests, your teams', then your own pull requests. */
export function sidebarEntries(current: View, settings: Settings): Entry[] {
  return [
    ...current.reviewing.filter((entry) => entry.direct),
    ...settings.sidebarTeams ? onTeam(current.teams, settings.team).filter((entry) => !entry.direct) : [],
    ...settings.sidebarMine ? current.mine.filter((entry) => entry.pending) : [],
  ]
}

export function reviewers(pr: PullRequest): string {
  const hidden = pr.requested.filter((reviewer) => reviewer.kind === "hidden").length
  return [
    ...pr.requested.flatMap((reviewer) => reviewer.kind === "user" ? [`@${reviewer.name}`] : reviewer.kind === "team" ? [reviewer.name] : []),
    ...hidden ? [`${hidden} hidden`] : [],
  ].join(", ")
}

export function matches(entry: Entry, query: string): boolean {
  const { pr } = entry
  return matchesText([pr.title, pr.author, pr.repository, `#${pr.number}`, entry.label, reviewers(pr), ...entry.teams].join(" "), query)
}
