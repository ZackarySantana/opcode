import { versionedSchema } from "@opcode/core/follow"
import { empty, failed as errors, object } from "@opcode/core/rpc"
import { Rpc } from "@opencode/plugin/rpc"
import { ignoreChoices, orderChoices, PLUGIN_ID, refreshChoices, sidebarItemChoices, type SettingsChange } from "./model"

const text = { type: "string" } as const
const flag = { type: "boolean" } as const
const choices = {
  order: { type: "string", enum: orderChoices }, ignoreDays: { type: "integer", enum: ignoreChoices }, sidebarMine: flag, sidebarTeams: flag,
  sidebarItems: { type: "integer", enum: sidebarItemChoices }, refreshMinutes: { type: "integer", enum: refreshChoices },
}
const settings = object({ ...choices, team: text }, Object.keys(choices))
/** `PullRequestsState` in model.ts. */
const state = object({
  ...versionedSchema, settings, refreshing: flag, error: text, nextRefreshIn: { type: "number" },
  // The server's own parse of gh's output: not validated field by field.
  snapshot: { type: "object" },
}, ["server", "started", "revision", "settings", "refreshing"])

/** The terminal's contract with the server plugin, which owns the pull requests and settings every terminal shows. */
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
    /** The full state after each change. */
    changed: { schema: state },
  },
})

/** `update`'s input. */
export interface UpdateInput {
  readonly settings: SettingsChange
}

/** `feedback`'s output. */
export interface FormattedFeedback {
  readonly number: number
  readonly text?: string
  readonly summary: string
}
