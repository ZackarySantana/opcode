/**
 * One value per server process, shared by every location instance of a server plugin. The host loads a server plugin's
 * files afresh for each location (it clears their module cache: see `prepareSource` in @opencode/plugin's
 * source.bun.js), so module-level variables are per location; the process's globals are shared. Key it by the code's
 * version too: a reloaded plugin starts its own value rather than joining one built by other code.
 */
export function joinShared<Member, Value>(key: string, member: Member, lifecycle: {
  /** Runs only for the first member, when no value is running: later members' `start` is never called. */
  start(members: () => readonly Member[]): Value
  /** Runs when the last member leaves. */
  stop(value: Value): void
}) {
  const symbol = Symbol.for(key)
  const registry = globalThis as typeof globalThis & { [key: symbol]: { value: Value; members: Member[] } | undefined }
  let shared = registry[symbol]
  if (shared) shared.members.push(member)
  else {
    const members = [member]
    // Members leave by splicing, so the start function's view always lists those still joined, oldest first.
    shared = registry[symbol] = { members, value: lifecycle.start(() => members) }
  }
  const joined = shared
  let left = false
  return {
    value: joined.value,
    leave() {
      if (left) return
      left = true
      joined.members.splice(joined.members.indexOf(member), 1)
      if (joined.members.length) return
      if (registry[symbol] === joined) delete registry[symbol]
      lifecycle.stop(joined.value)
    },
  }
}

/** The first of `members` that does the work, so a member that is leaving, or whose host is gone, doesn't stop it. */
export async function failover<Member, T>(members: () => readonly Member[], use: (member: Member) => Promise<T>): Promise<T> {
  let failure: unknown = new Error("No plugin instance is loaded")
  for (const member of [...members()]) {
    try { return await use(member) } catch (error) { failure = error }
  }
  throw failure
}
