export const DATE_RANGES = ["today", "7d", "30d", "all"] as const
export type DateRange = (typeof DATE_RANGES)[number]
export const IMPORT_BATCH_SIZE = 100

/** Only usage metadata crosses RPC or reaches the ledger. */
export interface Usage {
  messageID: string
  providerID: string
  modelID: string
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
export interface DashboardFilter {
  range: DateRange
  projectID?: string
  model?: string
}

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
  projectOptions: Array<{ id: string; label: string; directory: string }>
  modelOptions: Array<{ id: string; label: string }>
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

export function rangeLabel(range: DateRange) {
  return { today: "today", "7d": "last 7 days", "30d": "last 30 days", all: "all time" }[range]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function parseFilter(value: unknown): DashboardFilter {
  if (!isRecord(value) || !DATE_RANGES.includes(value.range as DateRange)) throw new Error("Invalid date range")
  for (const key of ["projectID", "model"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 1025)) {
      throw new Error(`Invalid ${key}`)
    }
  }
  return { range: value.range as DateRange, projectID: value.projectID as string | undefined, model: value.model as string | undefined }
}

/** Also validate in the handler: direct adapters/tests must not bypass the boundary. */
export function parseImportBatch(value: unknown): { sessionID: string; records: Usage[] } {
  if (!isRecord(value) || !validID(value.sessionID) || !Array.isArray(value.records)
    || value.records.length < 1 || value.records.length > IMPORT_BATCH_SIZE) throw new Error("Invalid import batch")
  const records = value.records.map((record): Usage => {
    if (!isRecord(record) || !validID(record.messageID) || !validID(record.providerID) || !validID(record.modelID)) {
      throw new Error("Invalid usage identity")
    }
    for (const key of ["createdAt", "cost", "input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) {
      if (!validNumber(record[key], key === "createdAt" ? 8.64e15 : key === "cost" ? 1e12 : 1e15)) throw new Error(`Invalid usage ${key}`)
    }
    if (record.completedAt !== undefined && (!validNumber(record.completedAt, 8.64e15) || (record.completedAt as number) < (record.createdAt as number))) {
      throw new Error("Invalid completion timestamp")
    }
    // Reconstruct, rather than persisting arbitrary client-supplied fields.
    return {
      messageID: record.messageID, providerID: record.providerID, modelID: record.modelID,
      createdAt: record.createdAt as number, completedAt: record.completedAt as number | undefined,
      cost: record.cost as number, input: record.input as number, output: record.output as number,
      reasoning: record.reasoning as number, cacheRead: record.cacheRead as number, cacheWrite: record.cacheWrite as number,
    }
  })
  return { sessionID: value.sessionID, records }
}

function validID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
}

function validNumber(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
}
