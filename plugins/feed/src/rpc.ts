import { versionedSchema } from "@opcode/core/follow"
import { empty, failed as errors, object } from "@opcode/core/rpc"
import { Rpc } from "@opencode/plugin/rpc"
import { kinds, PLUGIN_ID, refreshChoices, scopeChoices, sidebarItemChoices, windowChoices } from "./model"

const text = { type: "string" } as const
const kind = { type: "string", enum: kinds }
const choices = {
  windowHours: { type: "integer", enum: windowChoices }, resolved: { type: "string", enum: scopeChoices }, sidebarReleases: { type: "boolean" },
  sidebarItems: { type: "integer", enum: sidebarItemChoices }, refreshMinutes: { type: "integer", enum: refreshChoices },
}
const subscription = object({ url: text, title: text, kind, createdAt: { type: "number" } }, ["url", "kind", "createdAt"])
/** `FeedsState` in model.ts. */
const state = object({
  ...versionedSchema, settings: object(choices, Object.keys(choices)), subscriptions: { type: "array", items: subscription },
  // The server's own reading of each feed: not validated field by field.
  results: { type: "object" },
  nextRefreshIn: { type: "number" }, error: text,
}, ["server", "started", "revision", "settings", "subscriptions", "results"])

/** The terminal's contract with the server plugin, which owns the subscriptions, settings, and fetches every terminal shows. */
export const FeedRpc = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    state: { input: empty, output: state, errors },
    update: { input: object({ settings: object(choices, []) }, ["settings"]), output: state, errors },
    /** Adds the feed unless it's there, and fetches it. */
    subscribe: { input: object({ url: text, kind }, ["url", "kind"]), output: state, errors },
    unsubscribe: { input: object({ url: text }, ["url"]), output: state, errors },
    /** Fetches every feed now and restarts the countdown. */
    refresh: { input: empty, output: state, errors },
  },
  events: {
    /** The full state after changes. */
    changed: { schema: state },
  },
})
