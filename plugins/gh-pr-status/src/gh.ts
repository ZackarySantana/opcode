import type { Comment, Feedback, Thread } from "./comments"
import type { PullRequest, Reviewer, Search, Snapshot } from "./model"

/** Runs gh in `cwd`, or the client's working directory. */
export type Runner = (args: readonly string[], signal: AbortSignal, cwd?: string) => Promise<{ stdout: string; stderr: string; status: number }>

export const runGh: Runner = async (args, signal, cwd) => {
  const gh = Bun.which("gh")
  if (!gh) throw new Error("GitHub CLI (gh) not found. Install it, then run gh auth login.")
  const child = Bun.spawn([gh, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal })
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
  viewerLatestReview { state submittedAt }
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
  viewerLatestReview: { state: string; submittedAt: string | null } | null
  timelineItems: { nodes: { createdAt?: string; requestedReviewer?: RawReviewer }[] }
}
interface GraphQLResponse {
  data?: { viewer: { login: string } } & Record<keyof typeof searches, { nodes: (RawPullRequest | null)[] } | null> | null
  errors?: GraphQLError[]
}

/** A user's login, or a team as "org/slug"; undefined when the token can't see who it is. */
const nameOf = (raw: RawReviewer) => raw?.slug && raw.organization ? `${raw.organization.login}/${raw.slug}` : raw?.login

const checks = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "running", EXPECTED: "running" } as const
const decisions = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const

function parsePullRequest(raw: RawPullRequest): PullRequest {
  const requestedAt = new Map<string, number>()
  for (const event of raw.timelineItems.nodes) {
    const name = event.requestedReviewer && nameOf(event.requestedReviewer)
    if (name && event.createdAt) requestedAt.set(name, Math.max(requestedAt.get(name) ?? 0, Date.parse(event.createdAt)))
  }
  const requested = raw.reviewRequests.nodes.map(({ requestedReviewer }): Reviewer => {
    const name = nameOf(requestedReviewer)
    return name ? { kind: requestedReviewer?.slug ? "team" : "user", name, requestedAt: requestedAt.get(name) } : { kind: "hidden" }
  })
  // latestReviews can leave yours out, such as an approval of commits since rebased away. A draft review has no submittedAt.
  const yours = raw.viewerLatestReview
  const state = raw.commits.nodes[0]?.commit.statusCheckRollup?.state
  return {
    url: raw.url, number: raw.number, title: raw.title, repository: raw.repository.nameWithOwner, author: raw.author?.login ?? "ghost",
    draft: raw.isDraft, createdAt: Date.parse(raw.createdAt), conflicts: raw.mergeable === "CONFLICTING",
    decision: decisions.find((decision) => decision === raw.reviewDecision),
    checks: state ? checks[state as keyof typeof checks] : undefined,
    requested,
    yourReview: yours?.submittedAt ? { state: yours.state, submittedAt: Date.parse(yours.submittedAt) } : undefined,
  }
}

const SAML = "authorize GitHub CLI for your organization's single sign-on at github.com/settings/connections/applications"

type GraphQLError = { message: string; path?: (string | number)[]; extensions?: { saml_failure?: boolean } }

/** gh's JSON output, or why there is none. */
function json<T>(stdout: string, stderr: string, status: number): T {
  try { return JSON.parse(stdout) } catch {
    // gh exits 4 when it has no credentials.
    throw new Error(status === 4 ? "Not signed in to GitHub. Run gh auth login." : stderr.trim() || "gh returned no data")
  }
}

const failure = (errors: GraphQLError[] | undefined, stderr: string) =>
  new Error(errors?.[0]?.extensions?.saml_failure ? `GitHub withheld this data: ${SAML}` : errors?.[0]?.message ?? (stderr.trim() || "gh returned no data"))

/** Parses gh's output. GraphQL reports items it may not show (SAML-enforced orgs) as errors beside partial data. */
export function parseResponse(stdout: string, stderr: string, status = 0): Omit<Snapshot, "teams"> {
  const response = json<GraphQLResponse>(stdout, stderr, status)
  const data = response.data
  if (!data) throw failure(response.errors, stderr)
  const search = (alias: keyof typeof searches): Search => {
    const nodes = data[alias]?.nodes ?? []
    const prs = nodes.filter((node): node is RawPullRequest => node !== null).map(parsePullRequest)
    const error = response.errors?.find((error) => error.path?.[0] === alias)
    return { prs, hidden: nodes.length - prs.length, reason: error?.extensions?.saml_failure ? SAML : error?.message }
  }
  return { viewer: data.viewer.login, mine: search("mine"), requested: search("requested"), reviewed: search("reviewed") }
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

const feedbackQuery = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes { isResolved isOutdated path line startLine originalLine originalStartLine comments(first: 100) { nodes { ...comment url diffHunk } } } }
    reviews(first: 100) { nodes { ...comment url state } }
    comments(first: 100) { nodes { ...comment url } }
  } }
}
fragment comment on Comment { author { __typename login } body }`

type RawComment = { author: { __typename: string; login: string } | null; body: string; url: string }
interface FeedbackResponse {
  data?: { viewer: { login: string }; repository: { pullRequest: {
    reviewThreads: { nodes: (Omit<Thread, "comments" | "diffHunk"> & { comments: { nodes: (RawComment & { diffHunk: string })[] } })[] }
    reviews: { nodes: (RawComment & { state: string })[] }
    comments: { nodes: RawComment[] }
  } | null } | null } | null
  errors?: GraphQLError[]
}

const comment = (raw: RawComment): Comment => ({ author: raw.author?.login ?? "ghost", bot: raw.author?.__typename === "Bot", body: raw.body, url: raw.url })

/** Review feedback on the pull request for the branch checked out in `directory`, as gh resolves it. */
export async function fetchFeedback(run: Runner, signal: AbortSignal, directory: string): Promise<Feedback> {
  const view = await run(["pr", "view", "--json", "number,title,url,headRefName,state"], signal, directory)
  // Without one, gh prints only an explanation, such as "no pull requests found for branch ...".
  const pr = json<{ number: number; title: string; url: string; headRefName: string; state: string }>(view.stdout, view.stderr, view.status)
  const url = new URL(pr.url)
  const [, owner, name] = url.pathname.split("/")
  // gh api queries the default host, not the repository's, such as a GitHub Enterprise server's.
  const result = await run(["api", "graphql", "--hostname", url.host, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr.number}`, "-f", `query=${feedbackQuery}`], signal, directory)
  const response = json<FeedbackResponse>(result.stdout, result.stderr, result.status)
  const raw = response.data?.repository?.pullRequest
  if (!response.data || !raw) throw failure(response.errors, result.stderr)
  return {
    viewer: response.data.viewer.login,
    pr: { number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, state: pr.state },
    threads: raw.reviewThreads.nodes.map((thread) => ({ ...thread, diffHunk: thread.comments.nodes[0]?.diffHunk, comments: thread.comments.nodes.map(comment) })),
    reviews: raw.reviews.nodes.map((review) => ({ ...comment(review), state: review.state })),
    comments: raw.comments.nodes.map(comment),
  }
}
