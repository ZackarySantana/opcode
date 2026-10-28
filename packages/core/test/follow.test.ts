import { afterEach, expect, test } from "bun:test"
import { followState, newer, type Versioned } from "../src/follow"
import { eventually, manualTimers, stopped } from "../test-support/server"

type State = Versioned & { readonly value: string }
const state = (server: string, started: number, revision: number, value: string): State => ({ server, started, revision, value })

/** A server whose reads and announcements the test makes. */
function source(initial: State) {
  const subscribers = new Set<(state: State) => void>()
  const ends = new Set<() => void>()
  const source = {
    reads: 0,
    latest: initial,
    /** Answers the next read instead, once. */
    nextRead: undefined as (() => Promise<State>) | undefined,
    read: async () => {
      source.reads++
      const next = source.nextRead
      source.nextRead = undefined
      return next ? await next() : source.latest
    },
    announce: (state: State) => subscribers.forEach((push) => push(state)),
    /** Ends every subscription, as a dropped connection does. */
    disconnect: () => ends.forEach((end) => end()),
    changes: (signal: AbortSignal): AsyncIterable<State> => ({
      async *[Symbol.asyncIterator]() {
        const queue: State[] = []
        let wake = () => {}
        let ended = false
        const push = (state: State) => { queue.push(state); wake() }
        const end = () => { ended = true; wake() }
        subscribers.add(push)
        ends.add(end)
        signal.addEventListener("abort", end, { once: true })
        try {
          while (!ended) {
            if (queue.length) yield queue.shift()!
            else await new Promise<void>((resolve) => { wake = resolve })
          }
        } finally {
          subscribers.delete(push)
          ends.delete(end)
        }
      },
    }),
  }
  return source
}

const followers: { dispose(): void }[] = []
afterEach(() => { for (const follower of followers.splice(0)) follower.dispose() })

function follow(from: ReturnType<typeof source>, timer = stopped) {
  const applied: string[] = []
  const problems: (string | undefined)[] = []
  const follower = followState<State>({
    read: from.read, changes: from.changes, timer,
    apply: (state) => applied.push(state.value),
    problem: (message) => problems.push(message),
    describe: (error) => `described: ${(error as { message: string }).message}`,
  })
  followers.push(follower)
  follower.start()
  return { follower, applied, problems }
}

test("a later service's state replaces an earlier one's; within a service, a later revision does", () => {
  expect(newer(state("a", 100, 1, ""), undefined)).toBe(true)
  expect(newer(state("a", 100, 2, ""), state("a", 100, 1, ""))).toBe(true)
  expect(newer(state("a", 100, 1, ""), state("a", 100, 1, ""))).toBe(false)
  expect(newer(state("b", 200, 0, ""), state("a", 100, 9, ""))).toBe(true)
  expect(newer(state("old", 50, 9, ""), state("a", 100, 1, ""))).toBe(false)
})

test("states apply once each, newest only, through duplicates, late arrivals, and an older service", async () => {
  const from = source(state("a", 100, 1, "first"))
  const { applied } = follow(from)
  await eventually(() => expect(applied).toEqual(["first"]))
  from.announce(state("a", 100, 3, "third"))
  from.announce(state("a", 100, 2, "second"))
  from.announce(state("old", 50, 9, "old"))
  from.announce(state("a", 100, 3, "third"))
  from.announce(state("b", 200, 0, "restarted"))
  await eventually(() => expect(applied.at(-1)).toBe("restarted"))
  expect(applied).toEqual(["first", "third", "restarted"])
})

test("a change announced while disconnected is read on reconnecting", async () => {
  const from = source(state("a", 1, 1, "first"))
  const { applied } = follow(from)
  await eventually(() => expect(applied).toEqual(["first"]))
  from.disconnect()
  from.latest = state("a", 1, 2, "missed")
  await eventually(() => expect(applied).toEqual(["first", "missed"]), 5_000)
})

test("a failed read says why and reads again later; the next state clears the problem", async () => {
  const timers = manualTimers()
  const from = source(state("a", 1, 1, "first"))
  from.nextRead = async () => { throw { message: "Server restarting" } }
  const { applied, problems } = follow(from, timers.timer)
  await eventually(() => expect(problems).toEqual(["described: Server restarting"]))
  expect(timers.pending(30_000)).toBe(1)
  timers.fire(30_000)
  await eventually(() => expect(applied).toEqual(["first"]))
  expect(problems.at(-1)).toBeUndefined()
})

test("a failed call reads what it may have missed, then says what failed; resync reads again", async () => {
  const from = source(state("a", 1, 1, "first"))
  const { follower, applied, problems } = follow(from)
  await eventually(() => expect(applied).toEqual(["first"]))
  from.latest = state("a", 1, 4, "moved on")
  await follower.failed({ message: "disk full" })
  expect(applied).toEqual(["first", "moved on"])
  expect(problems.at(-1)).toBe("described: disk full")
  from.latest = state("a", 1, 5, "resynced")
  await follower.resync()
  expect(applied.at(-1)).toBe("resynced")
  follower.offer(state("a", 1, 6, "offered"))
  expect(applied.at(-1)).toBe("offered")
})
