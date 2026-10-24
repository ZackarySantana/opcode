import { usageMetrics } from "@opcode/core/usage"
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
/** `truncated`: the scan budget expired; rows are the matches found before it did. */
export interface SearchOutput { rows: SessionResult[]; projects: ProjectOption[]; truncated: boolean }
export interface RefreshOutput { sessions: number; deferred: number; failed: number }
export interface HistoryOutput { imported: number; unchanged: number; skipped: number; oversized: number }

export function sessionRecord(session: SessionInfo): SessionRecord {
  return {
    id: session.id, projectID: session.projectID, directory: session.location.directory,
    title: session.title ?? "Untitled session", ...(session.parentID != null ? { parentID: session.parentID } : {}),
    createdAt: session.time.created, updatedAt: session.time.updated,
  }
}

export function messageRecord(message: SessionMessageInfo): MessageRecord | undefined {
  if (message.type !== "user" && message.type !== "assistant") return
  const assistant = message.type === "assistant" ? message : undefined
  return {
    id: message.id, role: message.type, createdAt: message.time.created,
    text: message.type === "user" ? message.text.trim() : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim(),
    ...(assistant ? { providerID: assistant.model.providerID, modelID: assistant.model.id } : {}),
    ...usageMetrics(assistant),
  }
}

export function clampSelection(selected: number, count: number) {
  return Math.max(0, Math.min(selected, count - 1))
}

export const projectName = (directory: string) => directory.split(/[\\/]/).filter(Boolean).at(-1) || directory
