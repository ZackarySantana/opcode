import { plainText, type FeedItem } from "./parse"
import type { FeedKind } from "./presets"

/** How urgently an item should read. `news` is any item without a status, e.g. a release or blog post. */
export type Phase = "active" | "monitoring" | "maintenance" | "scheduled" | "resolved" | "news"

export interface Interpretation {
  readonly phase: Phase
  /** The provider's own label for the latest post, e.g. "Identified". */
  readonly status?: string
  readonly title: string
  /** The latest post's text, or the start of a release or article. */
  readonly summary?: string
}

const phases: Record<string, Phase> = {
  investigating: "active", identified: "active", update: "active", ongoing: "active",
  "partial outage": "active", "major outage": "active", "degraded performance": "active",
  monitoring: "monitoring", mitigated: "monitoring", verifying: "monitoring", recovering: "monitoring",
  "in progress": "maintenance", scheduled: "scheduled",
  resolved: "resolved", completed: "resolved", postmortem: "resolved", closed: "resolved", operational: "resolved",
}

// Statuspage's "Update" means still in progress; it reads as "Ongoing" here.
const label = (status: string) => status.toLowerCase() === "update" ? "Ongoing" : status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()
// Unknown labels are still a live status, but not presumed to be an outage.
const phaseOf = (status: string): Phase => phases[status.toLowerCase()] ?? "monitoring"

/** Google's titles inline a markdown summary: keep only its first section. */
function cleanTitle(title: string): string {
  const summary = title.match(/\*\*Summary:?\*\*:?\s*([\s\S]*?)(?:\*\*|$)/)
  return (summary?.[1] ?? title).replace(/\*\*/g, "").trim() || title
}

function excerpt(markup: string, limit = 180): string | undefined {
  const text = plainText(markup).replace(/\s*The post .* appeared first on .*$/, "")
  if (!text) return undefined
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}

const settled = /\b(?:resolved|operating normally|functioning (?:normally|as expected)|returned to normal|fully recovered|has recovered)\b/i

/**
 * Release feeds are always news; their markup is never read as a status. Status feeds use the
 * Statuspage, incident.io, or Google formats, falling back to the wording of the latest post.
 */
export function interpret(item: FeedItem, kind: FeedKind): Interpretation {
  const content = item.content ?? ""
  if (kind === "release") return { phase: "news", title: cleanTitle(item.title), summary: content ? excerpt(content) : undefined }
  let title = item.title
  // Statuspage: newest post first, "<strong>Identified</strong> - text".
  const statuspage = content.match(/<strong>\s*([A-Za-z ]{3,30}?)\s*<\/strong>\s*-\s*([\s\S]*?)(?:<\/p>|$)/i)
  if (statuspage) return { phase: phaseOf(statuspage[1]!), status: label(statuspage[1]!), title, summary: excerpt(statuspage[2]!) }
  // incident.io: "<b>Status: Monitoring</b><br/><br/>text<br/><br/><b>Affected components</b>".
  const incident = content.match(/<b>\s*Status:\s*([^<]+?)\s*<\/b>([\s\S]*?)(?:<b>|$)/i)
  if (incident) return { phase: phaseOf(incident[1]!), status: label(incident[1]!), title, summary: excerpt(incident[2]!) }
  // Google: "RESOLVED: …" titles, and "Incident began at … and ended at …" bodies.
  const prefix = title.match(/^([A-Z][A-Z ]{2,20}):\s+/)
  if (prefix && phases[prefix[1]!.toLowerCase()]) title = title.slice(prefix[0].length)
  if (prefix || /Incident began at/i.test(content)) {
    const status = prefix && phases[prefix[1]!.toLowerCase()] ? prefix[1]! : /ended at/i.test(content) ? "resolved" : "ongoing"
    const section = content.match(/Summary:?\s*<\/strong>:?\s*<\/p>\s*<p>([\s\S]*?)<\/p>/i)?.[1]
    const description = content.match(/Description:?\s*<\/strong>:?\s*<\/p>\s*<p>([\s\S]*?)<\/p>/i)?.[1]
    return { phase: phaseOf(status), status: label(status), title: cleanTitle(section ? plainText(section) : title), summary: description ? excerpt(description) : undefined }
  }
  // Plain status feeds (Slack, AWS): "Incident: …" titles and prose posts.
  title = title.replace(/^Incident:\s*/i, "")
  const resolved = settled.test(`${title} ${plainText(content)}`)
  return { phase: resolved ? "resolved" : "monitoring", status: resolved ? "Resolved" : "Ongoing", title: cleanTitle(title), summary: content ? excerpt(content) : undefined }
}

export const inProgress = (phase: Phase) => phase === "active" || phase === "monitoring" || phase === "maintenance"
