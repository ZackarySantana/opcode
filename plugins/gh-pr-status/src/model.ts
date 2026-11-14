import type { Versioned } from "@opcode/core/follow"
import { matchesText } from "@opcode/tabs/format"

export const PLUGIN_ID = "opcode-gh-pr-status"

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
  /** Its last activity on GitHub, such as a push, comment, review, or review request. */
  readonly updatedAt: number
  readonly conflicts: boolean
  readonly decision?: "APPROVED" | "REVIEW_REQUIRED"
  readonly checks?: "passing" | "failing" | "running"
  readonly requested: readonly Reviewer[]
  /** Your latest submitted review, such as "APPROVED". */
  readonly yourReview?: { readonly state: string; readonly submittedAt: number }
  /** Each person's latest submitted review, such as "COMMENTED". Bots' are left out. */
  readonly reviews: readonly Review[]
}

export interface Review {
  readonly author: string
  readonly state: string
  readonly submittedAt: number
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
  /** Needs your eyes: a request for your review by name, or a reviewer's comments on yours. */
  readonly eyes: boolean
  readonly since: Since
}

/**
 * When it came to you, which lists sort by: when your review, or your team's, was requested; when a reviewer first asked
 * for changes to yours; otherwise when it opened.
 */
export interface Since {
  readonly event: "requested" | "reviewed" | "opened"
  readonly at: number
}

export type Order = "smart" | "newest" | "oldest"

export type ScopeMode = "exclude" | "include"

/**
 * Which pull requests every list shows, by the org (or user) that owns their repository, compared case-insensitively:
 * all but the chosen orgs', or only theirs. Nothing chosen shows them all, in either mode.
 */
export interface Scope {
  readonly mode: ScopeMode
  readonly orgs: readonly string[]
}

export const scopeModes: readonly ScopeMode[] = ["exclude", "include"]
export const defaultScope: Scope = { mode: "exclude", orgs: [] }

export interface Settings {
  readonly order: Order
  /** Pull requests with no activity in this many days are left out everywhere; 0 keeps them all. */
  readonly ignoreDays: number
  /** The orgs whose pull requests show everywhere. */
  readonly scope: Scope
  /** Your open pull requests, in the sidebar. */
  readonly sidebarMine: boolean
  /** Review requests for your teams, in the sidebar, narrowed to `team` when set. */
  readonly sidebarTeams: boolean
  readonly sidebarItems: number
  readonly refreshMinutes: number
  /** The Teams tab's filter, as "org/slug". */
  readonly team?: string
}

export const defaultSettings: Settings = { order: "smart", ignoreDays: 30, scope: defaultScope, sidebarMine: true, sidebarTeams: true, sidebarItems: 5, refreshMinutes: 5 }
export const orderChoices: readonly Order[] = ["smart", "newest", "oldest"]
export const ignoreChoices: readonly number[] = [0, 7, 14, 30, 90, 365]
export const sidebarItemChoices: readonly number[] = [3, 5, 10, 15, 20]
export const refreshChoices: readonly number[] = [1, 2, 5, 10, 15, 30]

/** Chooses an org, or unchooses it. */
export interface ScopeOrgChange {
  readonly name: string
  readonly chosen: boolean
}

/**
 * A change to some settings; a null team clears the Teams tab's filter. The scope changes a part at a time, and each
 * part says what it becomes rather than flipping it, so changes made at once, here or in another terminal, all apply.
 */
export type SettingsChange = Partial<Omit<Settings, "team" | "scope">> & {
  readonly team?: string | null
  readonly scopeMode?: ScopeMode
  readonly scopeOrg?: ScopeOrgChange
}

/** GitHub's names are case-insensitive. */
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const byName = (a: string, b: string) => a.localeCompare(b)
const ownerOf = (repository: string) => repository.split("/")[0]!
/** An org's name, as a repository's owner: no slash or space. */
const isOrg = (value: unknown): value is string => typeof value === "string" && /^[^/\s]+$/.test(value)

const fieldChoices: { readonly [Key in Exclude<keyof Settings, "team" | "scope">]: readonly Settings[Key][] } = {
  order: orderChoices, ignoreDays: ignoreChoices, sidebarMine: [true, false], sidebarTeams: [true, false],
  sidebarItems: sidebarItemChoices, refreshMinutes: refreshChoices,
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? { ...value } : {}

/** The fields of `input` that are one of their choices, and a team as a name, or null to clear it. */
function readFields(input: Record<string, unknown>): Partial<Omit<Settings, "team" | "scope">> & { team?: string | null } {
  const fields: Record<string, unknown> = {}
  for (const [key, choices] of Object.entries(fieldChoices)) if ((choices as readonly unknown[]).includes(input[key])) fields[key] = input[key]
  if (input.team === null || typeof input.team === "string" && input.team) fields.team = input.team
  return fields
}

/** A stored scope; undefined unless its mode is one of the modes and its orgs are all names, kept once each, sorted. */
function readScope(value: unknown): Scope | undefined {
  const input = record(value)
  const mode = scopeModes.find((mode) => mode === input.mode)
  const orgs = input.orgs
  if (!mode || !Array.isArray(orgs) || !orgs.every(isOrg)) return undefined
  return { mode, orgs: orgs.filter((name, index) => orgs.findIndex((other) => sameName(other, name)) === index).sort(byName) }
}

function readScopeOrg(value: unknown): ScopeOrgChange | undefined {
  const input = record(value)
  return isOrg(input.name) && typeof input.chosen === "boolean" ? { name: input.name, chosen: input.chosen } : undefined
}

/** The parts of `value` that are valid changes. Anything else is left out. */
export function readChange(value: unknown): SettingsChange {
  const input = record(value)
  const scopeMode = scopeModes.find((mode) => mode === input.scopeMode)
  const scopeOrg = readScopeOrg(input.scopeOrg)
  return { ...readFields(input), ...scopeMode ? { scopeMode } : {}, ...scopeOrg ? { scopeOrg } : {} }
}

/**
 * Settings from stored JSON, whatever its shape: each field that isn't one of its choices keeps its default, so stored
 * data from any version reads. The team is left out unless set, as JSON has no undefined.
 */
export function readSettings(stored: unknown): Settings {
  const input = record(stored)
  const { team, ...fields } = readFields(input)
  return { ...defaultSettings, ...fields, scope: readScope(input.scope) ?? defaultScope, ...team ? { team } : {} }
}

/** Chooses an org, or unchooses it, regardless of case. */
function chooseOrg(scope: Scope, { name, chosen }: ScopeOrgChange): Scope {
  const others = scope.orgs.filter((org) => !sameName(org, name))
  return { ...scope, orgs: chosen ? [...others, name].sort(byName) : others }
}

/** The settings after a change, as the server saves it and a client shows it while it's on its way. */
export function applyChange(settings: Settings, change: SettingsChange): Settings {
  const { team, scopeMode, scopeOrg, ...fields } = change
  const { team: current, ...rest } = settings
  const moded = scopeMode ? { ...settings.scope, mode: scopeMode } : settings.scope
  const kept = team === null ? undefined : team ?? current
  return { ...rest, ...fields, scope: scopeOrg ? chooseOrg(moded, scopeOrg) : moded, ...kept ? { team: kept } : {} }
}

/** What the server shares with every client: the settings, and the latest refresh from GitHub and when the next starts. */
export interface PullRequestsState extends Versioned {
  readonly settings: Settings
  readonly snapshot?: Snapshot
  /** Why the last refresh failed; the snapshot before it stays. */
  readonly error?: string
  readonly refreshing: boolean
  /** How long until the next automatic refresh when the state was made: clients count from receipt, whatever their clock. */
  readonly nextRefreshIn?: number
}

/** A request GitHub matched to you without naming the team, which your token can't see. */
export const HIDDEN_TEAM = "hidden team"

/**
 * Reviews on your pull request asking you for changes: changes requested, or comments, which teams use alike. A reviewer
 * you've requested again since is back to reviewing.
 */
function feedback(pr: PullRequest): Review[] {
  const again = (review: Review) => pr.requested.some((reviewer) => reviewer.kind === "user" && reviewer.name === review.author
    && (reviewer.requestedAt === undefined || reviewer.requestedAt > review.submittedAt))
  return pr.reviews.filter((review) => review.author !== pr.author && ["CHANGES_REQUESTED", "COMMENTED"].includes(review.state) && !again(review))
}

function authored(pr: PullRequest): Entry {
  const asks = feedback(pr)
  const since: Since = asks.length ? { event: "reviewed", at: Math.min(...asks.map((review) => review.submittedAt)) } : { event: "opened", at: pr.createdAt }
  const entry = (label: string, tone: Tone, pending: boolean): Entry => ({ pr, label, tone, pending, own: true, direct: false, teams: [], eyes: !!asks.length, since })
  if (pr.draft) return entry("Draft", "quiet", false)
  if (pr.conflicts) return entry("Conflicts", "urgent", true)
  if (pr.checks === "failing") return entry("Checks failing", "urgent", true)
  if (asks.some((review) => review.state === "CHANGES_REQUESTED")) return entry("Changes requested", "urgent", true)
  if (asks.length) return entry("Review comments", "urgent", true)
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
  const requestedAt = direct ? direct.requestedAt : times.length ? Math.max(...times) : undefined
  const since: Since = requestedAt === undefined ? { event: "opened", at: pr.createdAt } : { event: "requested", at: requestedAt }
  const shared = { pr, own: false, direct: !!direct, teams: names, since }
  if (![...direct ? [direct] : [], ...teams, ...unseen].some(waits)) return { ...shared, ...reviewStatus(pr), pending: false, eyes: false }
  return {
    ...shared, pending: true, eyes: !!direct, tone: "attention",
    label: direct ? "Review requested" : !teams.length ? "Team review" : `Team: ${team}${names.length > 1 ? ` +${names.length - 1}` : ""}`,
  }
}

function reviewStatus(pr: PullRequest): { label: string; tone: Tone } {
  if (pr.yourReview?.state === "APPROVED") return { label: "You approved", tone: "quiet" }
  if (pr.yourReview?.state === "CHANGES_REQUESTED") return { label: "You requested changes", tone: "waiting" }
  return { label: "You commented", tone: "quiet" }
}

const reviewed = (pr: PullRequest): Entry =>
  ({ pr, ...reviewStatus(pr), pending: false, own: false, direct: false, teams: [], eyes: false, since: { event: "opened", at: pr.createdAt } })

/** Unordered: GitHub's search returns them by last update, and `ordered` sorts them for display. */
export interface View {
  readonly mine: readonly Entry[]
  /** Review requests for you, and pull requests you've reviewed. */
  readonly reviewing: readonly Entry[]
  /** Review requests for your teams, including ones that also request you. */
  readonly teams: readonly Entry[]
}

/** Whether the pull requests of a repository ("owner/name") show: nothing chosen shows every one. */
export function inScope(scope: Scope, repository: string): boolean {
  if (!scope.orgs.length) return true
  return scope.orgs.some((org) => sameName(org, ownerOf(repository))) === (scope.mode === "include")
}

/** What leaves pull requests out of every list. */
export type Filter = Pick<Settings, "ignoreDays" | "scope">

/** Leaves out pull requests with no activity in the `ignoreDays` before `now` (0 keeps them all), and those out of scope. */
export function view(snapshot: Snapshot | undefined, filter: Filter = { ignoreDays: 0, scope: defaultScope }, now = Date.now()): View {
  if (!snapshot) return { mine: [], reviewing: [], teams: [] }
  const after = filter.ignoreDays ? now - filter.ignoreDays * 86_400_000 : -Infinity
  const active = (search: Search) => search.prs.filter((pr) => pr.updatedAt >= after && inScope(filter.scope, pr.repository))
  const requests = active(snapshot.requested).filter((pr) => pr.author !== snapshot.viewer).flatMap((pr) => requested(pr, snapshot) ?? [])
  const direct = requests.filter((entry) => entry.direct)
  const byName = new Set(direct.map((entry) => entry.pr.url))
  return {
    mine: active(snapshot.mine).map(authored),
    reviewing: [...direct, ...active(snapshot.reviewed).filter((pr) => !byName.has(pr.url)).map(reviewed)],
    teams: requests.filter((entry) => entry.teams.length),
  }
}

/** By when each came to you; smart puts what needs your eyes first, then the rest, each oldest first. */
export function ordered(entries: readonly Entry[], order: Order): Entry[] {
  const time = (a: Entry, b: Entry) => order === "newest" ? b.since.at - a.since.at : a.since.at - b.since.at
  return [...entries].sort((a, b) => order === "smart" && a.eyes !== b.eyes ? a.eyes ? -1 : 1 : time(a, b))
}

export const onTeam = (entries: readonly Entry[], team: string | undefined) => team ? entries.filter((entry) => entry.teams.includes(team)) : entries

/** Teams to filter by: yours, any requested of you, and the saved filter, so it can be cleared even once gone. */
export function teamChoices(snapshot: Snapshot, entries: readonly Entry[], saved: string | undefined): string[] {
  return [...new Set([...snapshot.teams, ...entries.flatMap((entry) => entry.teams), ...saved ? [saved] : []])].sort()
}

/** Each pull request once, from every list. */
const listed = (current: View) => new Map([...current.mine, ...current.reviewing, ...current.teams].map((entry) => [entry.pr.url, entry.pr]))

export interface ScopeChoice {
  readonly name: string
  /** Pull requests the lists show for it, before the scope applies. */
  readonly count: number
  readonly chosen: boolean
}

/**
 * The orgs to choose from, matching `query`: the owners of every open pull request in the snapshot, active or not, the
 * orgs of your teams, and the chosen ones, so they can be unchosen once gone. Each once regardless of case, sorted.
 */
export function scopeChoices(snapshot: Snapshot | undefined, filter: Filter, query = "", now = Date.now()): ScopeChoice[] {
  const { orgs: chosen } = filter.scope
  const prs = snapshot ? [snapshot.mine, snapshot.requested, snapshot.reviewed].flatMap((search) => search.prs) : []
  const counted = [...listed(view(snapshot, { ...filter, scope: defaultScope }, now)).values()]
  const names = [...prs.map((pr) => ownerOf(pr.repository)), ...(snapshot?.teams ?? []).map(ownerOf), ...chosen]
  // The last spelling of each wins, so a chosen org shows as it was chosen.
  const orgs = [...new Map(names.map((name) => [name.toLowerCase(), name])).values()].sort(byName)
  return orgs.filter((name) => matchesText(name, query)).map((name) => ({
    name,
    chosen: chosen.some((org) => sameName(org, name)),
    count: counted.filter((pr) => sameName(ownerOf(pr.repository), name)).length,
  }))
}

/** How many pull requests the scope leaves listed, of how many it could. */
export function scopeCount(snapshot: Snapshot | undefined, filter: Filter, now = Date.now()): { shown: number; total: number } {
  return { shown: listed(view(snapshot, filter, now)).size, total: listed(view(snapshot, { ...filter, scope: defaultScope }, now)).size }
}

/** The sidebar's one list: review requests waiting on you, your teams' (narrowed by the filter), and your open pull requests. */
export function sidebarEntries(current: View, settings: Settings): Entry[] {
  return ordered([
    ...current.reviewing.filter((entry) => entry.pending),
    ...settings.sidebarTeams ? onTeam(current.teams, settings.team).filter((entry) => entry.pending && !entry.direct) : [],
    ...settings.sidebarMine ? current.mine : [],
  ], settings.order)
}

export function matches(entry: Entry, query: string): boolean {
  const { pr } = entry
  const reviewers = pr.requested.flatMap((reviewer) => reviewer.kind === "hidden" ? [] : [reviewer.name])
  return matchesText([pr.title, pr.author, pr.repository, `#${pr.number}`, entry.label, ...reviewers, ...entry.teams].join(" "), query)
}
