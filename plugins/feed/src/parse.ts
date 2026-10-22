export interface FeedItem {
  readonly id: string
  readonly title: string
  readonly link?: string
  /** Epoch milliseconds, when the feed provides a parseable date. */
  readonly published?: number
  /** The item body as markup (description, summary, or content), with feed-level escaping removed. */
  readonly content?: string
}

export interface Feed {
  readonly title?: string
  readonly items: readonly FeedItem[]
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }

function unescape(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, name: string) => {
      if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : match
      }
      return entities[name.toLowerCase()] ?? match
    })
}

/** Text content of a markup fragment, with whitespace collapsed. */
export function plainText(markup: string): string {
  return unescape(markup.replace(/<br\s*\/?>|<\/p>|<\/li>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
}

const decode = (value: string) => plainText(unescape(value))

function markup(xml: string, ...tags: string[]): string | undefined {
  for (const tag of tags) {
    const [value] = blocks(xml, tag)
    if (value !== undefined && value.trim()) return unescape(value)
  }
  return undefined
}

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"))].map((match) => match[1]!)
}

function field(xml: string, ...tags: string[]): string | undefined {
  for (const tag of tags) {
    const [value] = blocks(xml, tag)
    if (value !== undefined) return decode(value) || undefined
  }
  return undefined
}

function date(value: string | undefined): number | undefined {
  const time = value ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : undefined
}

function atomLink(entry: string): string | undefined {
  const links = [...entry.matchAll(/<link\b([^>]*)\/?>/gi)].map((match) => match[1]!)
  const preferred = links.find((attributes) => !/rel=/.test(attributes) || /rel=["']alternate["']/.test(attributes)) ?? links[0]
  return preferred?.match(/href=["']([^"']+)["']/)?.[1]
}

/** Parses RSS 2.0 and Atom feeds. Items keep feed order, which is newest-first for every preset. */
export function parseFeed(xml: string): Feed {
  if (/<feed[\s>]/i.test(xml)) {
    const header = xml.split(/<entry[\s>]/i)[0] ?? ""
    return {
      title: field(header, "title"),
      items: blocks(xml, "entry").map((entry) => {
        const link = atomLink(entry)
        const title = field(entry, "title") ?? "(untitled)"
        return { id: field(entry, "id") ?? link ?? title, title, link, published: date(field(entry, "updated", "published")), content: markup(entry, "summary", "content") }
      }),
    }
  }
  if (!/<rss[\s>]|<rdf:RDF[\s>]/i.test(xml)) throw new Error("Not an RSS or Atom feed")
  const channel = blocks(xml, "channel")[0] ?? xml
  const header = channel.split(/<item[\s>]/i)[0] ?? ""
  return {
    title: field(header, "title"),
    items: blocks(xml, "item").map((item) => {
      const link = field(item, "link")
      const title = field(item, "title") ?? "(untitled)"
      return { id: field(item, "guid") ?? link ?? title, title, link, published: date(field(item, "pubDate", "dc:date")), content: markup(item, "description", "content:encoded") }
    }),
  }
}
