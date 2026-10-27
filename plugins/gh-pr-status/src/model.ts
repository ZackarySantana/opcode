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
  /** Your latest submitted review, such as "APPROVED". */
  readonly yourReview?: { readonly state: string; readonly submittedAt: number }
}

export interface Search {
  readonly prs: readonly PullRequest[]
  /** Results GitHub withheld, such as pull requests in SAML-enforced orgs, and what to do about it. */
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
  /** Yours, rather than one you review. */
  readonly own: boolean
  /** Requests your review, not just your team's. */
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
  const entry = (label: string, tone: Tone, pending: boolean): Entry => ({ pr, label, tone, pending, own: true, direct: false, teams: [] })
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

/**
 * A pull request GitHub's search says requests your review, directly or through one of your teams, checked against its
 * current reviewers: the search can lag behind a review you just submitted. Undefined when nothing requested could be you.
 */
function requested(pr: PullRequest, snapshot: Snapshot): Entry | undefined {
  const viewer = snapshot.viewer.toLowerCase()
  const direct = pr.requested.find((reviewer): reviewer is Named => reviewer.kind === "user" && reviewer.name.toLowerCase() === viewer)
  const visible = pr.requested.filter((reviewer): reviewer is Named => reviewer.kind === "team")
  const known = visible.filter((team) => snapshot.teams.includes(team.name))
  // Only without your team list (no read:org) may any visible team be yours. A request that isn't for you by name
  // and matches none of your teams came through a team your token can't see, or a team it can but your list lacks.
  const teams = known.length || snapshot.teams.length || direct ? known : visible
  const unseen = direct || teams.length ? [] : pr.requested.filter((reviewer) => reviewer.kind !== "user")
  if (!direct && !teams.length && !unseen.length) return undefined
  // A review satisfies every request made before it; one made since, or at an unknown time, still waits on you.
  // GitHub drops your own request when you review, but can keep a team's, such as one a ruleset requires.
  const reviewedAt = pr.yourReview?.submittedAt
  const waits = (reviewer: Reviewer) => reviewer.kind === "hidden" || reviewer.requestedAt === undefined || reviewedAt === undefined || reviewer.requestedAt > reviewedAt
  const names = [...teams.map((team) => team.name), ...unseen.length ? [HIDDEN_TEAM] : []]
  const times = teams.flatMap((team) => team.requestedAt ?? [])
  const team = names[0]?.split("/").pop()
  const shared = { pr, own: false, direct: !!direct, teams: names, requestedAt: direct ? direct.requestedAt : times.length ? Math.max(...times) : undefined }
  if (![...direct ? [direct] : [], ...teams, ...unseen].some(waits)) return { ...shared, ...reviewStatus(pr), pending: false }
  return {
    ...shared, pending: true, tone: "attention",
    label: direct ? "Review requested" : !teams.length ? "Team review" : `Team: ${team}${names.length > 1 ? ` +${names.length - 1}` : ""}`,
  }
}

function reviewStatus(pr: PullRequest): { label: string; tone: Tone } {
  if (pr.yourReview?.state === "APPROVED") return { label: "You approved", tone: "quiet" }
  if (pr.yourReview?.state === "CHANGES_REQUESTED") return { label: "You requested changes", tone: "waiting" }
  return { label: "You commented", tone: "quiet" }
}

const reviewed = (pr: PullRequest): Entry => ({ pr, ...reviewStatus(pr), pending: false, own: false, direct: false, teams: [] })

/**
 * Newest first, by the time the sidebar shows: when your review, or your team's, was requested, or for your own, when it
 * opened. Ones without a known request time follow, by when they opened. GitHub's search returns them by last update.
 */
function newest(entries: Entry[]): Entry[] {
  const since = (entry: Entry) => (entry.own ? entry.pr.createdAt : entry.requestedAt) ?? 0
  return entries.sort((a, b) => since(b) - since(a) || b.pr.createdAt - a.pr.createdAt)
}

/** Each list is newest first, by when it was requested of you or your team, or for your own, when it opened. */
export interface View {
  readonly mine: readonly Entry[]
  /** Review requests for you, then pull requests you've reviewed. */
  readonly reviewing: readonly Entry[]
  /** Review requests for your teams; ones that also request you come first. */
  readonly teams: readonly Entry[]
}

export function view(snapshot: Snapshot | undefined): View {
  if (!snapshot) return { mine: [], reviewing: [], teams: [] }
  const requests = newest(snapshot.requested.prs.filter((pr) => pr.author !== snapshot.viewer).flatMap((pr) => requested(pr, snapshot) ?? []))
  const direct = requests.filter((entry) => entry.direct)
  const byName = new Set(direct.map((entry) => entry.pr.url))
  return {
    mine: newest(snapshot.mine.prs.map(authored)),
    reviewing: [...direct, ...newest(snapshot.reviewed.prs.filter((pr) => !byName.has(pr.url)).map(reviewed))],
    teams: [...direct, ...requests.filter((entry) => !entry.direct)].filter((entry) => entry.teams.length),
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
    ...current.reviewing.filter((entry) => entry.pending),
    ...settings.sidebarTeams ? onTeam(current.teams, settings.team).filter((entry) => entry.pending && !entry.direct) : [],
    ...settings.sidebarMine ? current.mine.filter((entry) => entry.pending) : [],
  ]
}

export function matches(entry: Entry, query: string): boolean {
  const { pr } = entry
  const reviewers = pr.requested.flatMap((reviewer) => reviewer.kind === "hidden" ? [] : [reviewer.name])
  return matchesText([pr.title, pr.author, pr.repository, `#${pr.number}`, entry.label, ...reviewers, ...entry.teams].join(" "), query)
}
