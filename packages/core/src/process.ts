import { readFileSync } from "node:fs"

type Shared<Member, Value> = { value: Value; members: Member[]; stop(value: Value): void }

/**
 * One value per server process, shared by every location instance of a server plugin. The host may load a plugin's
 * files afresh for each location: it clears their module cache (`prepareSource` in @opencode/plugin's source.bun.js),
 * and OpenCode 2.2.0 ran a separate module copy per location of a local plugin, so module-level variables may not be
 * shared. The process's globals are, so this is correct either way. Key it by the code's version (`packageVersion`)
 * too, so reloaded code starts its own value rather than joining one built by other code.
 */
export function joinShared<Member, Value>(key: string, member: Member, lifecycle: {
  /** Runs only for the first member, when no value is running: later members' `start` is never called. */
  start(members: () => readonly Member[]): Value
  /** The first member's runs when the last member leaves: whoever starts the value stops it. */
  stop(value: Value): void
}): { value: Value; leave(): void } {
  const symbol = Symbol.for(key)
  const registry = globalThis as typeof globalThis & { [key: symbol]: Shared<Member, Value> | undefined }
  let shared = registry[symbol]
  if (shared) shared.members.push(member)
  else {
    const members = [member]
    // Members leave by splicing, so `start`'s view always lists those still joined, oldest first.
    shared = registry[symbol] = { members, value: lifecycle.start(() => members), stop: lifecycle.stop }
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
      joined.stop(joined.value)
    },
  }
}

/**
 * The first of `members` that does the work, oldest first, so one that is leaving, or whose host is gone, doesn't stop
 * it. Members that leave meanwhile are skipped; when every member fails, the last failure is thrown.
 */
export async function failover<Member, T>(members: () => readonly Member[], use: (member: Member) => Promise<T>): Promise<T> {
  let failure: unknown = new Error("No plugin instance is loaded")
  for (const member of [...members()]) {
    if (!members().includes(member)) continue
    try { return await use(member) } catch (error) { failure = error }
  }
  throw failure
}

/** A package's version from its manifest, such as `new URL("../package.json", import.meta.url)`; "unknown" when unreadable. */
export function packageVersion(manifest: URL): string {
  try {
    const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }
    return typeof version === "string" ? version : "unknown"
  } catch { return "unknown" }
}
