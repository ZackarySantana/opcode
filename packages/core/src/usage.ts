/** Structural subset of provider-reported usage; every field may be missing or invalid. */
export type UsageSource = {
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}

export type UsageMetrics = { cost: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

const metric = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0

/** Missing, non-finite, and negative values become 0 so they cannot corrupt totals. */
export function usageMetrics(source: UsageSource | undefined): UsageMetrics {
  const tokens = source?.tokens
  return {
    cost: metric(source?.cost), input: metric(tokens?.input), output: metric(tokens?.output),
    reasoning: metric(tokens?.reasoning), cacheRead: metric(tokens?.cache?.read), cacheWrite: metric(tokens?.cache?.write),
  }
}
