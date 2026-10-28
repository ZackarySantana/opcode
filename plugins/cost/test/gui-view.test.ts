import { expect, test } from "bun:test"
import type { Breakdown, Dashboard, TimeDashboard } from "../src/domain.js"
import type { Ledger } from "../src/format.js"
import { breakdownTable, formatSpend, isEmpty, overview, spendLabel, turnRows } from "../src/gui/view.js"
import { en } from "../src/gui/i18n.js"

const row = (id: string, cost: number, tokens: number, messages = 1): Breakdown => ({ id, label: id, cost, tokens, messages })

function usage(cost: number, rows: Breakdown[] = []): Dashboard {
  const tokens = rows.reduce((sum, item) => sum + item.tokens, 0)
  return {
    total: { cost, messages: rows.reduce((sum, item) => sum + item.messages, 0), tokens, input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    projects: rows, models: rows, daily: rows,
  }
}

const noTime: TimeDashboard = { total: { agent: 0, turns: 0, wait: 0, parallel: 0, peak: 0 }, projects: [], models: [], daily: [], longest: [] }

test("the titlebar shows a short spend, or tokens when the day recorded no cost", () => {
  expect(formatSpend(0)).toBe("$0.00")
  expect(formatSpend(0.001)).toBe("<$0.01")
  expect(formatSpend(12.3456)).toBe("$12.35")
  expect(formatSpend(1_234)).toBe("$1.23K")
  expect(spendLabel(usage(2.5, [row("a", 2.5, 100)]))).toEqual({ key: "titlebar.cost", params: { amount: "$2.50" } })
  expect(spendLabel(usage(0, [row("a", 0, 12_000)]))).toEqual({ key: "titlebar.tokens", params: { tokens: "12K" } })
  expect(spendLabel(usage(0))).toEqual({ key: "titlebar.cost", params: { amount: "$0.00" } })
})

test("the overview drops the cost card without a recorded cost, and counts messages, turns, and sessions", () => {
  const time: TimeDashboard = { ...noTime, total: { agent: 3_723_000, turns: 1, wait: 90_000, parallel: 0, peak: 2 } }
  const priced = overview({ usage: usage(2, [row("a", 2, 1_500, 3)]), time })
  expect(priced[0]!.map((stat) => stat.id)).toEqual(["cost", "tokens", "output", "cache"])
  expect(priced[0]![0]).toMatchObject({ value: "$2.00", detail: { key: "stat.cost.detail", count: 3, params: { n: "3" } } })
  expect(priced[1]).toMatchObject([
    { id: "agent", value: "1h 02m", detail: { count: 1 } },
    { id: "wait", value: "1m 30s" },
    { id: "parallel", value: "0s", detail: { key: "stat.parallel.detail", count: 2 } },
  ])
  const free = overview({ usage: usage(0, [row("a", 0, 1_500, 1_200)]), time })
  expect(free[0]!.map((stat) => stat.id)).toEqual(["tokens", "output", "cache"])
  expect(free[0]![0]!.detail).toEqual({ key: "stat.tokens.detailMessages", count: 1_200, params: { input: "1.5K", n: "1,200" } })
})

test("every key the view model produces has English copy", () => {
  const time: TimeDashboard = { ...noTime, total: { ...noTime.total, turns: 2 } }
  const texts = [true, false].flatMap((priced) => overview({ usage: usage(priced ? 1 : 0, [row("a", priced ? 1 : 0, 5)]), time }).flat())
    .flatMap((stat) => [stat.label, stat.detail])
  texts.push(spendLabel(usage(1, [row("a", 1, 5)])), spendLabel(usage(0, [row("a", 0, 5)])))
  for (const text of texts) {
    const keys = text.count === undefined ? [text.key] : [`${text.key}.one`, `${text.key}.other`]
    for (const key of keys) expect(en).toHaveProperty([key])
  }
})

test("breakdown tables join usage and time, size bars by cost (or tokens without cost), and blank missing halves", () => {
  const time: TimeDashboard = {
    ...noTime,
    models: [{ id: "b", label: "b", agent: 60_000, wait: 0, turns: 2 }, { id: "turns-only", label: "turns-only", agent: 1_000, wait: 5_000, turns: 1 }],
  }
  const priced = breakdownTable({ usage: usage(4, [row("a", 3, 10), row("b", 1, 90)]), time }, "models")
  expect(priced.priced).toBe(true)
  expect(priced.rows.map(({ id, share }) => [id, share])).toEqual([["a", 1], ["b", 1 / 3], ["turns-only", 0]])
  expect(priced.rows[1]).toMatchObject({ cost: "$1.00", tokens: "90", messages: "1", agent: "1m 00s", turns: "2", wait: "0s" })
  expect(priced.rows[0]).toMatchObject({ agent: "", turns: "", wait: "" })
  expect(priced.rows[2]).toMatchObject({ cost: "", tokens: "", messages: "", turns: "1", wait: "5s" })
  const free = breakdownTable({ usage: usage(0, [row("a", 0, 10), row("b", 0, 40)]), time: noTime }, "models")
  expect(free.priced).toBe(false)
  expect(free.rows.map(({ id, share }) => [id, share])).toEqual([["a", 0.25], ["b", 1]])
})

test("daily rows are newest first, and empty ledgers are detected", () => {
  const ledger: Ledger = {
    usage: usage(1, [row("2026-07-01", 1, 1)]),
    time: { ...noTime, daily: [{ id: "2026-07-03", label: "2026-07-03", agent: 1, wait: 0, turns: 1 }] },
  }
  expect(breakdownTable(ledger, "daily").rows.map((item) => item.id)).toEqual(["2026-07-03", "2026-07-01"])
  expect(isEmpty(ledger)).toBe(false)
  expect(isEmpty({ usage: usage(0), time: noTime })).toBe(true)
})

test("turn rows carry their session for opening and format start and duration", () => {
  const start = new Date(2026, 6, 10, 9, 5).getTime()
  expect(turnRows([{ sessionID: "s", title: "Fix it", project: "p", directory: "/p", model: "m", start, duration: 125_000 }])).toEqual([
    { key: `s:${start}`, sessionID: "s", title: "Fix it", project: "p", model: "m", start: "2026-07-10 09:05", duration: "2m 05s" },
  ])
})
