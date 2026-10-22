import type { ConfigEntry, SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import { ContextRpc, type ToolSummary } from "./rpc"
import { buildSnapshot, type EnvironmentItem } from "./snapshot"

type Host = Pick<Context, "client" | "data" | "location">

export async function loadSnapshot(host: Host, sessionID?: string, signal?: AbortSignal) {
  if (!sessionID) return buildSnapshot({ messages: [], history: "unavailable" })
  const warnings: string[] = []
  const optional = async <T>(read: () => Promise<T>, fallback: () => T, warning: string): Promise<T> => {
    try { return await read() } catch {
      signal?.throwIfAborted()
      warnings.push(warning)
      return fallback()
    }
  }
  const session = await optional(() => host.client.session.get({ sessionID }, { signal }),
    () => host.data.session.get(sessionID), "Session metadata unavailable; using cache where available.")
  const location = session?.location ?? host.location ?? host.data.location.default()
  let history: "live" | "cached" | "unavailable" = "live"
  const [messages, retainedMessages, documents, tools] = await Promise.all([
    optional(async () => {
      const all: SessionMessageInfo[] = []
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        signal?.throwIfAborted()
        const page = await host.client.message.list({ sessionID, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) }, { signal })
        all.push(...page.data)
        cursor = page.cursor.next ?? undefined
        if (cursor && seen.has(cursor)) throw new Error("Repeated history cursor")
        if (cursor) seen.add(cursor)
      } while (cursor)
      return all
    }, () => {
      const cached = host.data.session.message.list(sessionID)
      history = cached === undefined ? "unavailable" : "cached"
      return cached ?? []
    }, "Session history unavailable; totals may cover cached history only."),
    optional(() => host.client.session.context({ sessionID }, { signal }), () => undefined,
      "Retained context unavailable; retained size and utilization are not estimated from history."),
    optional(() => host.client.config.get({ location }, { signal }), () => [] as ConfigEntry[],
      "Instruction configuration unavailable."),
    optional(() => host.client.rpc(ContextRpc).tools({}, { location, signal }) as Promise<ToolSummary[]>, () => [],
      "Tool catalog unavailable; enable opcode-context on the server."),
    ...[
      { collection: host.data.location.provider, label: "Providers" },
      { collection: host.data.location.model, label: "Models" },
      { collection: host.data.location.agent, label: "Agents" },
      { collection: host.data.location.skill, label: "Skills" },
      { collection: host.data.location.mcp.server, label: "MCP servers" },
    ].map(async ({ collection, label }) => {
      await optional(() => collection.sync(location), () => undefined,
        `${label} unavailable; showing cached metadata where available.`)
    }),
  ])
  signal?.throwIfAborted()
  const environment: EnvironmentItem[] = []
  for (const entry of documents) {
    if (entry.type !== "document") continue
    for (const name of entry.info.instructions ?? []) environment.push({ category: "instruction", name })
    for (const name of entry.info.skills ?? []) environment.push({ category: "skill", name, detail: "Configured source" })
  }
  for (const item of host.data.location.agent.list(location) ?? []) environment.push({ category: "agent", name: item.id, detail: item.description })
  for (const item of host.data.location.skill.list(location) ?? []) environment.push({ category: "skill", name: item.id, detail: item.description })
  for (const item of host.data.location.mcp.server.list(location) ?? []) {
    environment.push({ category: "mcp", name: item.name, detail: "error" in item.status ? item.status.error : item.status.status })
  }
  for (const item of tools) environment.push({ category: "tool", name: item.id, detail: item.description })
  return buildSnapshot({ sessionID, messages, retainedMessages, history, model: session?.model,
    models: host.data.location.model.list(location) ?? [], providers: host.data.location.provider.list(location) ?? [],
    environment, warnings })
}
