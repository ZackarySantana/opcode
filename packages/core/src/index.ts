/** Human-readable errors without assuming host/client error classes. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return "An unexpected error occurred"
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)
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
