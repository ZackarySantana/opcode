/** Status pages report incidents and maintenance; updates are releases, blogs, and news. */
export type FeedKind = "status" | "updates"

export interface Preset {
  readonly title: string
  readonly url: string
  readonly kind: FeedKind
}

/** Suggested feeds shown in the manager. Subscribing stores the URL, so presets can change freely. */
export const presets: readonly Preset[] = [
  { kind: "status", title: "npm", url: "https://status.npmjs.org/history.rss" },
  { kind: "status", title: "GitHub", url: "https://www.githubstatus.com/history.rss" },
  { kind: "status", title: "Google Workspace", url: "https://www.google.com/appsstatus/dashboard/en/feed.atom" },
  { kind: "status", title: "Google Cloud", url: "https://status.cloud.google.com/en/feed.atom" },
  { kind: "status", title: "Claude", url: "https://status.claude.com/history.rss" },
  { kind: "status", title: "OpenAI", url: "https://status.openai.com/history.rss" },
  { kind: "status", title: "Cloudflare", url: "https://www.cloudflarestatus.com/history.rss" },
  { kind: "status", title: "Fireworks", url: "https://status.fireworks.ai/history.rss" },
  { kind: "status", title: "AWS", url: "https://status.aws.amazon.com/rss/all.rss" },
  // Empty while every Azure service is healthy.
  { kind: "status", title: "Azure", url: "https://azure.status.microsoft/en-us/status/feed/" },
  { kind: "status", title: "Fly.io", url: "https://status.flyio.net/history.rss" },
  { kind: "status", title: "Slack", url: "https://slack-status.com/feed/rss" },
  { kind: "updates", title: "Claude Code releases", url: "https://github.com/anthropics/claude-code/releases.atom" },
  { kind: "updates", title: "OpenCode releases", url: "https://github.com/anomalyco/opencode/releases.atom" },
  { kind: "updates", title: "Bun releases", url: "https://github.com/oven-sh/bun/releases.atom" },
  { kind: "updates", title: "Node.js releases", url: "https://github.com/nodejs/node/releases.atom" },
  { kind: "updates", title: "OpenRouter models", url: "https://openrouter.ai/api/v1/models?use_rss=true" },
  { kind: "updates", title: "GitHub changelog", url: "https://github.blog/changelog/feed/" },
  { kind: "updates", title: "TypeScript blog", url: "https://devblogs.microsoft.com/typescript/feed/" },
  { kind: "updates", title: "Go blog", url: "https://go.dev/blog/feed.atom" },
  { kind: "updates", title: "Deno blog", url: "https://deno.com/feed" },
  { kind: "updates", title: "OpenAI news", url: "https://openai.com/news/rss.xml" },
  { kind: "updates", title: "Hacker News (300+ points)", url: "https://hnrss.org/frontpage?points=300" },
]

/** The URL a search box entry would add, when it plausibly is one: a dotted host or an explicit scheme, no spaces. */
export function candidateURL(text: string): string | undefined {
  const value = text.trim()
  if (!value || /\s/.test(value)) return undefined
  try {
    const url = new URL(feedURL(value))
    return /^https?:\/\//i.test(value) || url.hostname.includes(".") ? url.href : undefined
  } catch { return undefined }
}

export function feedURL(text: string): string {
  const value = text.trim()
  let url: URL
  try { url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`) }
  catch { throw new Error(`Not a URL: ${value}`) }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Feeds must use http or https")
  return url.href
}
