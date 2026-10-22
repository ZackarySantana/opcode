import { expect, test } from "bun:test"
import { usageMetrics } from "../src/usage"

test("valid provider usage is preserved", () => {
  expect(usageMetrics({ cost: 0.5, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } }))
    .toEqual({ cost: 0.5, input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })
})

test("missing, non-finite, and negative values cannot corrupt totals", () => {
  const zero = { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  expect(usageMetrics(undefined)).toEqual(zero)
  expect(usageMetrics({})).toEqual(zero)
  expect(usageMetrics({ cost: NaN, tokens: { input: -1, output: Infinity, reasoning: -Infinity } })).toEqual(zero)
  expect(usageMetrics({ tokens: { input: 7, cache: { read: NaN, write: -2 } } })).toEqual({ ...zero, input: 7 })
})
