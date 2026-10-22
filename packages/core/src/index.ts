/** Human-readable errors without assuming host/client error classes. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message
    : typeof error === "string" ? error
    : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message
    : undefined
  return message || "An unexpected error occurred"
}

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 })

export function formatCount(value: number): string {
  return count.format(value)
}

export function formatMoney(value: number): string {
  return money.format(value)
}

/** Serialize read/modify/write operations, without poisoning the queue on failure. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation)
    tail = result.catch(() => undefined)
    return result
  }
}
