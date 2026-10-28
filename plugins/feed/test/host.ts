import type { fakeServer } from "@opcode/core/test-support/server"
import type { Remote } from "../src/client"
import type { FeedsState } from "../src/model"

/** A terminal whose location is `directory`, on a fake server running the plugin. */
export function remote(server: ReturnType<typeof fakeServer>, directory = "/home/me"): Remote {
  return {
    state: (signal) => server.call<FeedsState>(directory, "state", {}, signal),
    update: (change) => server.call<FeedsState>(directory, "update", { settings: change }),
    subscribe: (url, kind) => server.call<FeedsState>(directory, "subscribe", { url, kind }),
    unsubscribe: (url) => server.call<FeedsState>(directory, "unsubscribe", { url }),
    refresh: () => server.call<FeedsState>(directory, "refresh", {}),
    changes: (signal) => ({
      async *[Symbol.asyncIterator]() {
        for await (const event of server.subscribe(signal)) if (event.name === "changed") yield event.data as FeedsState
      },
    }),
  }
}

export const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>npm Status - Incident History</title>
  <link>https://status.npmjs.org</link>
  <item>
    <title>Elevated errors &amp; latency</title>
    <description>&lt;p&gt;&lt;strong&gt;Resolved&lt;/strong&gt; - Fixed.&lt;/p&gt;</description>
    <pubDate>Tue, 20 Oct 2026 10:00:00 +0000</pubDate>
    <link>https://status.npmjs.org/incidents/abc</link>
    <guid>https://status.npmjs.org/incidents/abc</guid>
  </item>
  <item><title><![CDATA[Older <b>incident</b>]]></title><pubDate>Mon, 19 Oct 2026 10:00:00 +0000</pubDate></item>
</channel></rss>`

export const npm = "https://status.npmjs.org/history.rss"
