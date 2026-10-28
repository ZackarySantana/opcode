import { formatCount, formatMoney } from "@opcode/core"
import type { Dashboard, LongTurn } from "../domain.js"
import { formatDuration, formatStart, formatTokens, isPriced, joinBreakdown, type Dimension, type Ledger } from "../format.js"

/** Copy for `ctx.t`, or for `ctx.plural` when it has a count. Counts are also passed preformatted as `n`. */
export interface Text {
  key: string
  params?: Record<string, string>
  count?: number
}

const plural = (key: string, count: number, params: Record<string, string> = {}): Text => ({ key, count, params: { ...params, n: formatCount(count) } })

const compactMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** A short spend figure: cents, then K or M, and never a misleading $0.00 for a small spend. */
export function formatSpend(cost: number) {
  if (cost > 0 && cost < 0.005) return `<${compactMoney.format(0.01)}`
  return compactMoney.format(cost)
}

/** Today's spend for the titlebar, or tokens when nothing recorded a cost, as on a subscription. */
export function spendLabel(today: Dashboard): Text {
  if (isPriced(today) || today.total.tokens === 0) return { key: "titlebar.cost", params: { amount: formatSpend(today.total.cost) } }
  return { key: "titlebar.tokens", params: { tokens: formatTokens(today.total.tokens) } }
}

export interface Stat {
  id: string
  label: Text
  value: string
  detail: Text
}

/** Usage totals, then time totals: the same cards as the terminal's overview. */
export function overview(ledger: Ledger): Stat[][] {
  const usage = ledger.usage.total
  const time = ledger.time.total
  const priced = isPriced(ledger.usage)
  return [
    [
      ...priced ? [{ id: "cost", label: { key: "stat.cost" }, value: formatMoney(usage.cost), detail: plural("stat.cost.detail", usage.messages) }] : [],
      {
        id: "tokens", label: { key: "stat.tokens" }, value: formatTokens(usage.tokens),
        detail: priced
          ? { key: "stat.tokens.detail", params: { input: formatTokens(usage.input) } }
          : plural("stat.tokens.detailMessages", usage.messages, { input: formatTokens(usage.input) }),
      },
      { id: "output", label: { key: "stat.output" }, value: formatTokens(usage.output), detail: { key: "stat.output.detail", params: { reasoning: formatTokens(usage.reasoning) } } },
      { id: "cache", label: { key: "stat.cache" }, value: formatTokens(usage.cacheRead + usage.cacheWrite), detail: { key: "stat.cache.detail", params: { read: formatTokens(usage.cacheRead) } } },
    ],
    [
      { id: "agent", label: { key: "stat.agent" }, value: formatDuration(time.agent), detail: plural("stat.agent.detail", time.turns) },
      { id: "wait", label: { key: "stat.wait" }, value: formatDuration(time.wait), detail: { key: "stat.wait.detail" } },
      { id: "parallel", label: { key: "stat.parallel" }, value: formatDuration(time.parallel), detail: plural("stat.parallel.detail", time.peak) },
    ],
  ]
}

export function isEmpty(ledger: Ledger) {
  return ledger.usage.total.messages === 0 && ledger.time.total.turns === 0
}

/** One table row. Usage or time cells are blank when the row has only the other. */
export interface BreakdownRow {
  id: string
  label: string
  /** The bar's fill, from 0 to 1. */
  share: number
  cost: string
  tokens: string
  messages: string
  agent: string
  turns: string
  wait: string
}

/** A breakdown table: the cost column appears only when the range recorded a cost. */
export function breakdownTable(ledger: Ledger, dimension: Dimension): { priced: boolean; rows: BreakdownRow[] } {
  return {
    priced: isPriced(ledger.usage),
    rows: joinBreakdown(ledger, dimension).map(({ id, label, usage, time, share }) => ({
      id, label, share,
      cost: usage ? formatMoney(usage.cost) : "",
      tokens: usage ? formatTokens(usage.tokens) : "",
      messages: usage ? formatCount(usage.messages) : "",
      agent: time ? formatDuration(time.agent) : "",
      turns: time ? formatCount(time.turns) : "",
      wait: time ? formatDuration(time.wait) : "",
    })),
  }
}

export interface TurnRow {
  key: string
  sessionID: string
  title: string
  project: string
  model: string
  start: string
  duration: string
}

export function turnRows(turns: readonly LongTurn[]): TurnRow[] {
  return turns.map((turn) => ({
    key: `${turn.sessionID}:${turn.start}`, sessionID: turn.sessionID, title: turn.title, project: turn.project,
    model: turn.model, start: formatStart(turn.start), duration: formatDuration(turn.duration),
  }))
}
