import type { ModelInfo, ModelRef, ProviderInfo, SessionMessageInfo } from "@opencode/client"

export type EnvironmentItem = { category: "instruction" | "agent" | "skill" | "mcp" | "tool"; name: string; detail?: string }
export type Contributor = {
  id: string
  messageID: string
  category: "user" | "assistant" | "reasoning" | "tool" | "file" | "system"
  label: string
  characters: number
  bytes: number
  estimatedTokens: number
}
export type Snapshot = ReturnType<typeof buildSnapshot>
export type SnapshotInput = {
  sessionID?: string
  messages: readonly SessionMessageInfo[]
  retainedMessages?: readonly SessionMessageInfo[]
  history?: "live" | "cached" | "unavailable"
  model?: ModelRef
  models?: readonly ModelInfo[]
  providers?: readonly ProviderInfo[]
  environment?: readonly EnvironmentItem[]
  warnings?: string[]
  now?: Date
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4)
const unique = <T>(items: readonly T[], key: (item: T) => string) => [...new Map(items.map((item) => [key(item), item])).values()]

/** Measures only observable content; never substitutes stored history for retained context. */
export function buildSnapshot(input: SnapshotInput) {
  const messages = unique(input.messages, (message) => message.id)
  const assistants = messages.filter((message) => message.type === "assistant")
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
  let usageReports = 0
  for (const message of assistants) {
    if (!message.tokens) continue
    usageReports++
    usage.input += message.tokens.input
    usage.cacheRead += message.tokens.cache.read
    usage.cacheWrite += message.tokens.cache.write
    usage.output += message.tokens.output
    usage.reasoning += message.tokens.reasoning
  }
  const selected = input.model ?? assistants.at(-1)?.model
  const metadata = input.models?.find((model) => model.providerID === selected?.providerID && model.id === selected.id)
  const model = selected ? {
    providerID: selected.providerID,
    modelID: selected.id,
    providerName: input.providers?.find((provider) => provider.id === selected.providerID)?.name,
    modelName: metadata?.name,
    contextLimit: metadata?.limit.context,
  } : undefined
  const contributors = input.retainedMessages === undefined ? undefined
    : unique(input.retainedMessages, (message) => message.id).flatMap(contributions)
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.id.localeCompare(b.id))
  const retained = contributors === undefined ? undefined : {
    provenance: "estimated" as const,
    ...contributors.reduce((total, item) => ({
      characters: total.characters + item.characters,
      bytes: total.bytes + item.bytes,
      estimatedTokens: total.estimatedTokens + item.estimatedTokens,
    }), { characters: 0, bytes: 0, estimatedTokens: 0 }),
    contributors,
  }
  const compactions = messages.filter((message) => message.type === "compaction" && message.status === "completed")
  const utilization = retained && model?.contextLimit ? retained.estimatedTokens / model.contextLimit : undefined
  const warnings = [...new Set(input.warnings ?? [])]
  return {
    version: 1 as const,
    capturedAt: (input.now ?? new Date()).toISOString(),
    sessionID: input.sessionID,
    available: Boolean(input.sessionID),
    model,
    history: input.history ?? "live",
    usage,
    usageReports,
    usageProvenance: "recorded" as const,
    messageCount: { user: messages.filter((message) => message.type === "user").length, assistant: assistants.length },
    toolCalls: assistants.reduce((count, message) => count + message.content.filter((part) => part.type === "tool").length, 0),
    compaction: { count: compactions.length, latestBoundary: compactions.at(-1)?.id },
    retained,
    utilization,
    utilizationProvenance: utilization === undefined ? "unavailable" as const : "estimated" as const,
    cacheEfficiency: usage.input + usage.cacheRead > 0 ? usage.cacheRead / (usage.input + usage.cacheRead) : undefined,
    environment: unique(input.environment ?? [], (item) => `${item.category}:${item.name}`)
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
    warnings,
    limitations: [
      "Recorded tokens cover assistant history, not the next request or compaction billing.",
      "Retained tokens use ceil(UTF-16 characters / 4) per contributor; attachment payloads and opaque provider data are not measured.",
      "Hidden instructions and tool schemas are excluded; environment entries are available metadata, not proof of inclusion in a request.",
      ...warnings,
    ],
  }
}

function contributions(message: SessionMessageInfo): Contributor[] {
  const rows: Contributor[] = []
  const add = (id: string, category: Contributor["category"], label: string, text: string) => {
    if (!text) return
    rows.push({ id, messageID: message.id, category, label, characters: text.length, bytes: Buffer.byteLength(text), estimatedTokens: estimateTokens(text) })
  }
  const file = (id: string, name: string | null | undefined, mime: string, details: (string | null | undefined)[]) =>
    add(id, "file", `Attachment: ${name ?? mime}`, details.filter(Boolean).join(" "))
  switch (message.type) {
    case "user":
      add(`${message.id}:text`, "user", "User message", message.text)
      message.files?.forEach((item, index) => file(`${message.id}:file:${index}`, item.name, item.mime,
        [item.name, item.mime, item.description, item.source.type === "uri" ? item.source.uri : undefined]))
      break
    case "assistant":
      message.content.forEach((part, index) => {
        const id = `${message.id}:${index}`
        if (part.type === "text" || part.type === "reasoning") {
          add(id, part.type === "text" ? "assistant" : "reasoning", part.type === "text" ? "Assistant response" : "Reasoning", part.text)
          return
        }
        if (part.state.status !== "completed" && part.state.status !== "error") return
        const content = part.state.content ?? []
        const text = content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n")
        add(id, "tool", `Tool: ${part.name}`, text || (part.state.status === "error" ? part.state.error.message : ""))
        content.forEach((item, index) => {
          if (item.type === "file") file(`${id}:file:${index}`, item.name, item.mime, [item.name, item.mime, item.uri])
        })
      })
      break
    case "compaction":
      if (message.status === "completed") add(message.id, "system", "Compaction summary", message.summary)
      break
    case "system": case "synthetic": case "skill":
      add(message.id, "system", message.type === "skill" ? `Skill: ${message.name}` : "System message", message.text)
      break
    case "shell":
      if (message.output) add(message.id, "tool", "Shell output", message.output.output)
  }
  return rows
}
