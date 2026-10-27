import type { FileDiffInfo, OpenCodeClient } from "@opencode/client"
import type { Mode } from "./review"

/** Unchanged lines around each change. Leaving it out would send whole files. */
const CONTEXT = 3

export interface Target {
  readonly sessionID: string
  readonly directory: string
}

export type DiffClient = Pick<OpenCodeClient, "session" | "message" | "vcs">

/**
 * The files changed in a view, sorted by path. The session views come from the host's snapshots, so they stay live
 * while a step runs; the others are the working copy against HEAD, or against where it left a base branch.
 */
export async function loadDiff(client: DiffClient, target: Target, mode: Mode, base: string | undefined, signal: AbortSignal): Promise<FileDiffInfo[]> {
  const location = { directory: target.directory }
  const files = await (async () => {
    switch (mode) {
      case "turn": return await client.session.diff({ sessionID: target.sessionID, context: CONTEXT }, { signal })
      case "session": {
        const user = (order: "asc" | "desc") => client.message.list({ sessionID: target.sessionID, type: "user", order, limit: 1 }, { signal }).then((page) => page.data[0]?.id)
        const [from, to] = await Promise.all([user("asc"), user("desc")])
        if (!from) return []
        return await client.session.diff({ sessionID: target.sessionID, from, to, context: CONTEXT }, { signal })
      }
      case "working": return (await client.vcs.diff({ location, mode: "working", context: CONTEXT }, { signal })).data
      case "branch": {
        const name = base ?? (await client.vcs.base({ location }, { signal })).data?.name
        if (!name) throw new Error("No base branch found. Press d and choose a base.")
        return (await client.vcs.diff({ location, mode: "branch", base: name, context: CONTEXT }, { signal })).data
      }
    }
  })()
  return [...files].sort((a, b) => a.file.localeCompare(b.file))
}

/** Branches to compare against, for the picker. */
export async function listBranches(client: Pick<OpenCodeClient, "vcs">, directory: string, signal?: AbortSignal): Promise<string[]> {
  return [...(await client.vcs.branch.list({ location: { directory }, limit: 100 }, { signal })).data]
}
