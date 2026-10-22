import { paginate } from "@opcode/core/paginate"
import type { ConfigEntry, LocationRef, ModelInfo, ProviderInfo, SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import { ContextRpc, type ToolSummary } from "./rpc"
import { buildSnapshot, type EnvironmentItem } from "./snapshot"

type Host = Pick<Context, "client" | "data" | "location">
type Environment = { key: string; items: EnvironmentItem[]; models: ModelInfo[]; providers: ProviderInfo[]; warnings: string[] }

/** Degrades a failed read to its fallback with a warning; cancellation still propagates. */
function reader(warnings: string[], signal?: AbortSignal) {
  return async <T>(read: () => Promise<T>, fallback: () => T, warning: string): Promise<T> => {
    try { return await read() } catch {
      signal?.throwIfAborted()
      warnings.push(warning)
      return fallback()
    }
  }
}

async function loadEnvironment(host: Host, location: LocationRef, signal?: AbortSignal): Promise<Environment> {
  const warnings: string[] = []
  const optional = reader(warnings, signal)
  const [documents, tools] = await Promise.all([
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
  const items: EnvironmentItem[] = []
  for (const entry of documents) {
    if (entry.type !== "document") continue
    for (const name of entry.info.instructions ?? []) items.push({ category: "instruction", name })
    for (const name of entry.info.skills ?? []) items.push({ category: "skill", name, detail: "Configured source" })
  }
  for (const item of host.data.location.agent.list(location) ?? []) items.push({ category: "agent", name: item.id, detail: item.description })
  for (const item of host.data.location.skill.list(location) ?? []) items.push({ category: "skill", name: item.id, detail: item.description })
  for (const item of host.data.location.mcp.server.list(location) ?? []) {
    items.push({ category: "mcp", name: item.name, detail: "error" in item.status ? item.status.error : item.status.status })
  }
  for (const item of tools) items.push({ category: "tool", name: item.id, detail: item.description })
  return { key: JSON.stringify(location), items, warnings,
    models: host.data.location.model.list(location) ?? [], providers: host.data.location.provider.list(location) ?? [] }
}

/** Session data is read on every load; environment/catalog data only when `environment` is set, first used, or the location changes. */
export function createSnapshotLoader(host: Host, sessionID?: string) {
  let cached: Environment | undefined
  return async (signal?: AbortSignal, environment = true) => {
    if (!sessionID) return buildSnapshot({ messages: [], history: "unavailable" })
    const warnings: string[] = []
    const optional = reader(warnings, signal)
    const session = await optional(() => host.client.session.get({ sessionID }, { signal }),
      () => host.data.session.get(sessionID), "Session metadata unavailable; using cache where available.")
    const location = session?.location ?? host.location ?? host.data.location.default()
    const reuse = !environment && cached?.key === JSON.stringify(location) ? cached : undefined
    let history: "live" | "cached" | "unavailable" = "live"
    const [messages, retainedMessages, env] = await Promise.all([
      optional(async () => {
        const all: SessionMessageInfo[] = []
        const pages = paginate((cursor) => host.client.message.list({ sessionID, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) }, { signal }), signal)
        for await (const page of pages) all.push(...page)
        return all
      }, () => {
        const stored = host.data.session.message.list(sessionID) ?? []
        history = stored.length ? "cached" : "unavailable"
        return stored
      }, "Session history unavailable; totals may cover cached history only."),
      optional(() => host.client.session.context({ sessionID }, { signal }), () => undefined,
        "Retained context unavailable; retained size and utilization are not estimated from history."),
      reuse ?? loadEnvironment(host, location, signal),
    ])
    signal?.throwIfAborted()
    cached = env
    return buildSnapshot({ sessionID, messages, retainedMessages, history, model: session?.model,
      models: env.models, providers: env.providers, environment: env.items, warnings: [...warnings, ...env.warnings] })
  }
}
