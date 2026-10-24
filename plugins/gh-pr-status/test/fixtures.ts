const NOW = Date.now()
export const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString()

type Reviewer = { login: string } | { slug: string; organization: { login: string } } | null
export const user = (login: string): Reviewer => ({ login })
export const team = (name: string): Reviewer => { const [org, slug] = name.split("/"); return { slug: slug!, organization: { login: org! } } }

export function pr(number: number, title: string, options: {
  author?: string; draft?: boolean; conflicts?: boolean; decision?: string; checks?: string
  requested?: { reviewer: Reviewer; hours?: number }[]; review?: { state: string; hours?: number }
} = {}) {
  return {
    url: `https://github.com/acme/web/pull/${number}`, number, title, isDraft: options.draft ?? false, createdAt: hoursAgo(72),
    reviewDecision: options.decision ?? null, mergeable: options.conflicts ? "CONFLICTING" : "MERGEABLE",
    author: { login: options.author ?? "me" }, repository: { nameWithOwner: "acme/web" },
    commits: { nodes: [{ commit: { statusCheckRollup: options.checks ? { state: options.checks } : null } }] },
    reviewRequests: { nodes: (options.requested ?? []).map(({ reviewer }) => ({ requestedReviewer: reviewer })) },
    viewerLatestReview: options.review ? { state: options.review.state, submittedAt: hoursAgo(options.review.hours ?? 1) } : null,
    timelineItems: { nodes: (options.requested ?? []).filter(({ hours }) => hours !== undefined).map(({ reviewer, hours }) => ({ createdAt: hoursAgo(hours!), requestedReviewer: reviewer })) },
  }
}

const saml = "Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization."

/** gh's GraphQL output for "me", on acme/web and acme/api. One review request sits in a SAML-enforced org. */
export const response = JSON.stringify({
  data: {
    viewer: { login: "me" },
    mine: { nodes: [
      pr(1, "Fix login redirect", { conflicts: true, checks: "FAILURE" }),
      pr(2, "Add dark mode", { decision: "APPROVED", checks: "SUCCESS" }),
      pr(3, "Refactor the router", { draft: true }),
      pr(4, "Upgrade TypeScript", { decision: "REVIEW_REQUIRED", requested: [{ reviewer: user("alice") }] }),
    ] },
    requested: { nodes: [
      pr(10, "Cache build artifacts", { author: "alice", requested: [{ reviewer: user("me"), hours: 2 }, { reviewer: team("acme/web"), hours: 30 }] }),
      pr(11, "Speed up CI", { author: "bob", requested: [{ reviewer: team("acme/web"), hours: 5 }, { reviewer: team("acme/design") }] }),
      pr(12, "New billing API", { author: "carol", requested: [{ reviewer: team("acme/api"), hours: 8 }] }),
      pr(13, "Rotate secrets", { author: "dave", requested: [{ reviewer: null }] }),
      null,
    ] },
    reviewed: { nodes: [
      pr(10, "Cache build artifacts", { author: "alice", review: { state: "COMMENTED" } }),
      pr(20, "Docs for webhooks", { author: "erin", review: { state: "APPROVED" } }),
    ] },
  },
  errors: [{ type: "FORBIDDEN", path: ["requested", "nodes", 4], extensions: { saml_failure: true }, message: saml }],
})

export const teams = "acme/web\nacme/api\n"
