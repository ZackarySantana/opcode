export const DATE_RANGES = ["today", "7d", "30d", "all"] as const
export type DateRange = (typeof DATE_RANGES)[number]
export const IMPORT_BATCH_SIZE = 100
/** Shared by the RPC schema and handler validation. */
export const MAX_ID_LENGTH = 512
export const MAX_TIME = 8.64e15
export const MAX_COST = 1e12
export const MAX_TOKENS = 1e15

/** Only usage metadata crosses RPC or reaches the ledger. */
export interface Usage {
  messageID: string
  providerID: string
  modelID: string
  variant?: string
  createdAt: number
  completedAt?: number
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface CollectionContext {
  sessionID: string
  projectID: string
  directory: string
}

export type UsageRecord = Usage & CollectionContext

export interface Totals {
  cost: number
  messages: number
  tokens: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface Breakdown {
  id: string
  label: string
  cost: number
  messages: number
  tokens: number
}

export interface Dashboard {
  total: Totals
  projects: Breakdown[]
  models: Breakdown[]
  daily: Breakdown[]
}

/** Turn boundaries from root-session history: a delivered user prompt, or the session going idle. */
export const ACTIVITY_KINDS = ["prompt", "idle"] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]
export interface Activity {
  kind: ActivityKind
  at: number
}

/** A root session, as the server looked it up. Activity before `createdAt` was inherited by a fork. */
export interface TimedSession {
  sessionID: string
  projectID: string
  directory: string
  title?: string
  createdAt: number
}

export interface TimeTotals {
  /** Milliseconds from turn start to idle, summed over turns. */
  agent: number
  turns: number
  /** Milliseconds from idle to the next user prompt, each gap capped at WAIT_CAP. */
  wait: number
  /** Milliseconds with two or more root sessions busy. */
  parallel: number
  peak: number
}

export interface TimeBreakdown {
  id: string
  label: string
  agent: number
  wait: number
  turns: number
}

export interface LongTurn {
  sessionID: string
  title: string
  project: string
  directory: string
  model: string
  start: number
  duration: number
}

export interface TimeDashboard {
  total: TimeTotals
  projects: TimeBreakdown[]
  models: TimeBreakdown[]
  daily: TimeBreakdown[]
  longest: LongTurn[]
}

export interface ImportStatus {
  projectID: string
  directory: string
  lastImport: number | null
}

export function rangeStart(range: DateRange, now: number) {
  if (range === "all") return 0
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  if (range === "7d") date.setDate(date.getDate() - 6)
  if (range === "30d") date.setDate(date.getDate() - 29)
  return date.getTime()
}

/** The server's local calendar date, as `YYYY-MM-DD`. */
export function localDay(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function rangeLabel(range: DateRange) {
  return { today: "today", "7d": "last 7 days", "30d": "last 30 days", all: "all time" }[range]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function parseRange(value: unknown): DateRange {
  if (!isRecord(value) || !DATE_RANGES.includes(value.range as DateRange)) throw new Error("Invalid date range")
  return value.range as DateRange
}

/** Also validate in the handler: direct adapters/tests must not bypass the boundary. */
export function parseImportBatch(value: unknown): { sessionID: string; records: Usage[] } {
  if (!isRecord(value) || !validID(value.sessionID) || !Array.isArray(value.records)
    || value.records.length < 1 || value.records.length > IMPORT_BATCH_SIZE) throw new Error("Invalid import batch")
  const records = value.records.map((record): Usage => {
    if (!isRecord(record) || !validID(record.messageID) || !validID(record.providerID) || !validID(record.modelID)
      || (record.variant !== undefined && !validID(record.variant))) {
      throw new Error("Invalid usage identity")
    }
    for (const key of ["createdAt", "cost", "input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) {
      if (!validNumber(record[key], key === "createdAt" ? MAX_TIME : key === "cost" ? MAX_COST : MAX_TOKENS)) throw new Error(`Invalid usage ${key}`)
    }
    if (record.completedAt !== undefined && (!validNumber(record.completedAt, MAX_TIME) || (record.completedAt as number) < (record.createdAt as number))) {
      throw new Error("Invalid completion timestamp")
    }
    // Reconstruct, rather than persisting arbitrary client-supplied fields.
    return {
      messageID: record.messageID, providerID: record.providerID, modelID: record.modelID, variant: record.variant as string | undefined,
      createdAt: record.createdAt as number, completedAt: record.completedAt as number | undefined,
      cost: record.cost as number, input: record.input as number, output: record.output as number,
      reasoning: record.reasoning as number, cacheRead: record.cacheRead as number, cacheWrite: record.cacheWrite as number,
    }
  })
  return { sessionID: value.sessionID, records }
}

export function parseActivityBatch(value: unknown): { sessionID: string; activity: Activity[] } {
  if (!isRecord(value) || !validID(value.sessionID) || !Array.isArray(value.activity)
    || value.activity.length < 1 || value.activity.length > IMPORT_BATCH_SIZE) throw new Error("Invalid activity batch")
  const activity = value.activity.map((item): Activity => {
    if (!isRecord(item) || !ACTIVITY_KINDS.includes(item.kind as ActivityKind) || !validNumber(item.at, MAX_TIME)) throw new Error("Invalid activity")
    return { kind: item.kind as ActivityKind, at: item.at }
  })
  return { sessionID: value.sessionID, activity }
}

function validID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function validNumber(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
}
