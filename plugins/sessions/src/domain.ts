import type { SessionInfo, SessionMessageInfo } from "@opencode/client"

export interface SessionRecord {
  id: string
  projectID: string
  directory: string
  title: string
  parentID?: string
  createdAt: number
  updatedAt: number
}

export interface MessageRecord {
  id: string
  role: "user" | "assistant"
  createdAt: number
  text: string
  providerID?: string
  modelID?: string
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface SessionResult extends SessionRecord {
  snippet: string
  messageCount: number
  providerID?: string
  modelID?: string
  modelCount: number
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface SearchInput { query: string; projectID?: string; showSubagents: boolean; limit?: number }
export interface ProjectOption { id: string; directory: string; label: string }
export interface SearchOutput { rows: SessionResult[]; projects: ProjectOption[] }

export function sessionRecord(session: SessionInfo): SessionRecord {
  return {
    id: session.id, projectID: session.projectID, directory: session.location.directory,
    title: session.title ?? "Untitled session", ...(session.parentID != null ? { parentID: session.parentID } : {}),
    createdAt: session.time.created, updatedAt: session.time.updated,
  }
}

const usage = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0

export function messageRecord(message: SessionMessageInfo): MessageRecord | undefined {
  if (message.type !== "user" && message.type !== "assistant") return
  const assistant = message.type === "assistant" ? message : undefined
  return {
    id: message.id, role: message.type, createdAt: message.time.created,
    text: message.type === "user" ? message.text.trim() : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim(),
    ...(assistant ? { providerID: assistant.model.providerID, modelID: assistant.model.id } : {}),
    cost: usage(assistant?.cost), input: usage(assistant?.tokens?.input), output: usage(assistant?.tokens?.output),
    reasoning: usage(assistant?.tokens?.reasoning), cacheRead: usage(assistant?.tokens?.cache.read), cacheWrite: usage(assistant?.tokens?.cache.write),
  }
}

export function clampSelection(selected: number, count: number) {
  return Math.max(0, Math.min(selected, count - 1))
}

/** Keep the selected row on screen, including after a resize or result shrink. */
export function viewport(selected: number, count: number, capacity: number, previous = 0) {
  const size = Math.max(1, capacity)
  const selection = clampSelection(selected, count)
  const start = Math.max(0, Math.min(previous, selection, Math.max(0, count - size)))
  return { selected: selection, start: selection >= start + size ? selection - size + 1 : start, size }
}

export function resumeCommand(directory: string, sessionID: string) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  return `opencode ${quote(directory)} --session ${quote(sessionID)}`
}
