import type { PullRequest, Reviewer, Search, Snapshot } from "./model"

export type Runner = (args: readonly string[], signal: AbortSignal) => Promise<{ stdout: string; stderr: string; status: number }>

export const runGh: Runner = async (args, signal) => {
  const gh = Bun.which("gh")
  if (!gh) throw new Error("GitHub CLI (gh) not found. Install it, then run gh auth login.")
  const child = Bun.spawn([gh, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, status }
}

const LIMIT = 50
const searches = {
  mine: "is:pr is:open author:@me archived:false sort:updated-desc",
  // Includes requests to your teams.
  requested: "is:pr is:open review-requested:@me archived:false sort:updated-desc",
  reviewed: "is:pr is:open reviewed-by:@me -author:@me archived:false sort:updated-desc",
} as const

const reviewer = "__typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug organization { login } }"

const query = `query {
  viewer { login }
  ${Object.entries(searches).map(([alias, search]) => `${alias}: search(query: ${JSON.stringify(search)}, type: ISSUE, first: ${LIMIT}) { nodes { ...pr } }`).join("\n  ")}
}
fragment pr on PullRequest {
  url number title isDraft createdAt reviewDecision mergeable
  author { login }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 30) { nodes { requestedReviewer { ${reviewer} } } }
  latestReviews(first: 30) { nodes { author { login } state submittedAt } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 50) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ${reviewer} } } } }
}`

type RawReviewer = { login?: string; slug?: string; organization?: { login: string } } | null
interface RawPullRequest {
  url: string
  number: number
  title: string
  isDraft: boolean
  createdAt: string
  reviewDecision: string | null
  mergeable: string
  author: { login: string } | null
  repository: { nameWithOwner: string }
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
  reviewRequests: { nodes: { requestedReviewer: RawReviewer }[] }
  latestReviews: { nodes: { author: { login: string } | null; state: string; submittedAt: string | null }[] }
  timelineItems: { nodes: { createdAt?: string; requestedReviewer?: RawReviewer }[] }
}
interface GraphQLResponse {
  data?: { viewer: { login: string } } & Record<keyof typeof searches, { nodes: (RawPullRequest | null)[] } | null> | null
  errors?: { message: string; path?: (string | number)[]; extensions?: { saml_failure?: boolean } }[]
}

/** A user's login, or a team as "org/slug"; undefined when the token can't see who it is. */
const nameOf = (raw: RawReviewer) => raw?.slug && raw.organization ? `${raw.organization.login}/${raw.slug}` : raw?.login

const checks = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "running", EXPECTED: "running" } as const
const decisions = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const

function parsePullRequest(raw: RawPullRequest, viewer: string): PullRequest {
  const requestedAt = new Map<string, number>()
  for (const event of raw.timelineItems.nodes) {
    const name = event.requestedReviewer && nameOf(event.requestedReviewer)
    if (name && event.createdAt) requestedAt.set(name, Math.max(requestedAt.get(name) ?? 0, Date.parse(event.createdAt)))
  }
  const requested = raw.reviewRequests.nodes.map(({ requestedReviewer }): Reviewer => {
    const name = nameOf(requestedReviewer)
    return name ? { kind: requestedReviewer?.slug ? "team" : "user", name, requestedAt: requestedAt.get(name) } : { kind: "hidden" }
  })
  const yours = raw.latestReviews.nodes.find((review) => review.author?.login.toLowerCase() === viewer.toLowerCase())
  const state = raw.commits.nodes[0]?.commit.statusCheckRollup?.state
  return {
    url: raw.url, number: raw.number, title: raw.title, repository: raw.repository.nameWithOwner, author: raw.author?.login ?? "ghost",
    draft: raw.isDraft, createdAt: Date.parse(raw.createdAt), conflicts: raw.mergeable === "CONFLICTING",
    decision: decisions.find((decision) => decision === raw.reviewDecision),
    checks: state ? checks[state as keyof typeof checks] : undefined,
    requested,
    yourReview: yours?.state,
  }
}

const SAML = "authorize GitHub CLI for your organization's single sign-on at github.com/settings/connections/applications"

/** Parses gh's output. GraphQL reports items it may not show (SAML-enforced orgs) as errors beside partial data. */
export function parseResponse(stdout: string, stderr: string, status = 0): Omit<Snapshot, "teams"> {
  let response: GraphQLResponse
  try { response = JSON.parse(stdout) } catch {
    // gh exits 4 when it has no credentials.
    throw new Error(status === 4 ? "Not signed in to GitHub. Run gh auth login." : stderr.trim() || "gh returned no data")
  }
  const data = response.data
  if (!data) throw new Error(response.errors?.[0]?.message ?? (stderr.trim() || "gh returned no data"))
  const viewer = data.viewer.login
  const search = (alias: keyof typeof searches): Search => {
    const nodes = data[alias]?.nodes ?? []
    const prs = nodes.filter((node): node is RawPullRequest => node !== null).map((node) => parsePullRequest(node, viewer))
    const error = response.errors?.find((error) => error.path?.[0] === alias)
    return { prs, hidden: nodes.length - prs.length, reason: error?.extensions?.saml_failure ? SAML : error?.message }
  }
  return { viewer, mine: search("mine"), requested: search("requested"), reviewed: search("reviewed") }
}

/** Your pull requests, review requests, and reviews, with the teams you're on as "org/slug". */
export async function fetchSnapshot(run: Runner, signal: AbortSignal): Promise<Snapshot> {
  const [result, teams] = await Promise.all([
    run(["api", "graphql", "-f", `query=${query}`], signal),
    // Optional: without read:org, every visible team request on a PR requesting your review counts as yours.
    run(["api", "--paginate", "/user/teams", "--jq", `.[] | .organization.login + "/" + .slug`], signal).catch(() => undefined),
  ])
  return { ...parseResponse(result.stdout, result.stderr, result.status), teams: teams?.status === 0 ? teams.stdout.split("\n").filter(Boolean) : [] }
}
