import type { OpenCodeClient } from "@opencode/client"
import { Rpc } from "@opencode/plugin/rpc"
import { ignoreChoices, orderChoices, refreshChoices, sidebarItemChoices, type PullRequestsState, type SettingsChange } from "./model"

export const PLUGIN_ID = "opcode-gh-pr-status"

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object" as const, properties, required, additionalProperties: false })
const text = { type: "string" } as const
const flag = { type: "boolean" } as const
const empty = object({}, [])
// Undeclared handler errors reach clients only as a generic rpc.internal failure.
const errors = { failed: empty }
const choices = {
  order: { type: "string", enum: orderChoices }, ignoreDays: { type: "integer", enum: ignoreChoices }, sidebarMine: flag, sidebarTeams: flag,
  sidebarItems: { type: "integer", enum: sidebarItemChoices }, refreshMinutes: { type: "integer", enum: refreshChoices },
}
const settings = object({ ...choices, team: text }, Object.keys(choices))
const state = object({
  server: text, revision: { type: "integer", minimum: 0 }, settings, refreshing: flag, error: text, nextRefresh: { type: "number" },
  // The server's own parse of gh's output, sent as is.
  snapshot: { type: "object" },
}, ["server", "revision", "settings", "refreshing"])

export const GhPrStatusRpc = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    state: { input: empty, output: state, errors },
    update: { input: object({ settings: object({ ...choices, team: { type: ["string", "null"] } }, []) }, ["settings"]), output: state, errors },
    /** Refreshes now and restarts the countdown. */
    refresh: { input: empty, output: state, errors },
    /** Review feedback on the pull request for the branch checked out in the call's location, as the prompt to send. */
    feedback: {
      input: empty,
      // No text when nothing is left to send.
      output: object({ number: { type: "integer" }, text, summary: text }, ["number", "summary"]),
      errors,
    },
  },
  events: {
    /** The state after each change, from one location instance of the server process. */
    changed: { schema: state },
  },
})

export interface FormattedFeedback {
  readonly number: number
  readonly text?: string
  readonly summary: string
}

/** The server's pull request state, as a terminal reaches it. */
export interface Remote {
  state(signal?: AbortSignal): Promise<PullRequestsState>
  update(change: SettingsChange): Promise<PullRequestsState>
  refresh(): Promise<PullRequestsState>
  /** For the branch checked out in `directory` on the server. */
  feedback(directory: string, signal: AbortSignal): Promise<FormattedFeedback>
  /** Each published state, live only: states published while disconnected are missed. */
  changes(signal: AbortSignal): AsyncIterable<PullRequestsState>
}

/**
 * The state is the same in every location, so calls go to the terminal's own. The client is read for each call, since
 * it changes when the server restarts.
 */
export function createRemote(client: () => Pick<OpenCodeClient, "rpc">, location: () => { directory: string }): Remote {
  const rpc = () => client().rpc(GhPrStatusRpc)
  const call = (signal?: AbortSignal) => ({ location: location(), signal })
  return {
    state: async (signal) => await rpc().state({}, call(signal)) as PullRequestsState,
    update: async (change) => await rpc().update({ settings: change }, call()) as PullRequestsState,
    refresh: async () => await rpc().refresh({}, call()) as PullRequestsState,
    feedback: async (directory, signal) => await rpc().feedback({}, { location: { directory }, signal }) as FormattedFeedback,
    changes: (signal) => ({
      async *[Symbol.asyncIterator]() {
        for await (const event of rpc().events.subscribe("changed", { signal })) yield event.data as unknown as PullRequestsState
      },
    }),
  }
}
