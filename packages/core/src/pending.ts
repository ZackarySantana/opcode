import { createSerialQueue } from "./index"

/**
 * Changes a client sends its server one at a time, in order. Each is listed from when it's made until it's answered,
 * so a view can show them over the server's state and quick changes build on each other; a refused one leaves the
 * list, which undoes it. `changed` reports each new list.
 */
export function createPending<Change, Answer>(options: {
  send(change: Change): Promise<Answer>
  answered(answer: Answer): void
  failed(error: unknown): Promise<void> | void
  changed(pending: readonly Change[]): void
}): (change: Change) => Promise<void> {
  const sends = createSerialQueue()
  // Wrapped, so equal changes are told apart.
  let pending: readonly { change: Change }[] = []
  const set = (next: readonly { change: Change }[]) => {
    pending = next
    options.changed(next.map(({ change }) => change))
  }
  return (change) => {
    const entry = { change }
    set([...pending, entry])
    return sends(async () => {
      try { options.answered(await options.send(change)) }
      catch (error) { await options.failed(error) }
      finally { set(pending.filter((sent) => sent !== entry)) }
    })
  }
}
