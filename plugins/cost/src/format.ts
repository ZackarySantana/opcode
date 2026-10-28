import { localDay, type Breakdown, type Dashboard, type TimeBreakdown, type TimeDashboard } from "./domain.js"

/** Usage and time for one date range, read together so every view shows the same moment. */
export interface Ledger { usage: Dashboard; time: TimeDashboard }

export type Dimension = "models" | "projects" | "daily"

/** One rule for a whole view: with no recorded cost (subscriptions report $0), every figure is tokens. */
export function isPriced(usage: Dashboard) {
  return usage.total.cost > 0
}

/** One breakdown row with its usage, its time, or both, and its bar's fill from 0 to 1. */
export interface Joined {
  id: string
  label: string
  usage?: Breakdown
  time?: TimeBreakdown
  share: number
}

/** Usage and time joined by ID: usage order first, then rows with only turns. Bars follow cost, or tokens without any recorded cost. */
export function joinBreakdown(ledger: Ledger, dimension: Dimension): Joined[] {
  const usage = new Map(ledger.usage[dimension].map((row) => [row.id, row]))
  const time = new Map(ledger.time[dimension].map((row) => [row.id, row]))
  const priced = isPriced(ledger.usage)
  const value = (row: Breakdown | undefined) => row ? priced ? row.cost : row.tokens : 0
  const max = Math.max(0, ...[...usage.values()].map(value))
  const ids = [...new Set([...usage.keys(), ...time.keys()])]
  // Dates are newest first.
  if (dimension === "daily") ids.sort((a, b) => b.localeCompare(a))
  return ids.map((id) => {
    const row = usage.get(id)
    const turns = time.get(id)
    return { id, label: row?.label ?? turns!.label, usage: row, time: turns, share: max > 0 ? value(row) / max : 0 }
  })
}

const tokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 })

export function formatTokens(value: number) {
  return tokens.format(value)
}

export function formatDuration(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${seconds}s`
}

export function formatStart(at: number) {
  const date = new Date(at)
  return `${localDay(at)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}
