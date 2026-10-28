import { versionedSchema } from "@opcode/core/follow"
import { empty, failed as errors, object } from "@opcode/core/rpc"
import { Rpc } from "@opencode/plugin/rpc"
import { PLUGIN_ID, sidebarItemChoices } from "./domain"

const text = { type: "string" } as const
const flag = { type: "boolean" } as const
const time = { type: "number" } as const
/** `LaterItem` in domain.ts: an item as the caller saw it, so a change applies only if it is still that item. */
const item = object({ id: text, message: text, createdAt: time, updatedAt: time, completedAt: time }, ["id", "message", "createdAt", "updatedAt"])
const items = { type: "array", items: item } as const
const choices = { sidebarItems: { type: "integer", enum: sidebarItemChoices }, agentTools: flag }
/** `LaterState` in domain.ts. */
const state = object({ ...versionedSchema, active: items, completed: items, settings: object(choices, Object.keys(choices)) },
  ["server", "started", "revision", "active", "completed", "settings"])
/** `Written` in service.ts: whether the change applied, false when the item changed elsewhere first. */
const written = object({ changed: flag, state }, ["changed", "state"])

/** The terminal's contract with the server plugin, which owns the list and settings every terminal and the agent share. */
export const LaterRpc = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    state: { input: empty, output: state, errors },
    add: { input: object({ message: text }, ["message"]), output: object({ id: text, changed: flag, state }, ["id", "changed", "state"]), errors },
    edit: { input: object({ item, message: text }, ["item", "message"]), output: written, errors },
    complete: { input: object({ item }, ["item"]), output: written, errors },
    /** To the end of the active list. */
    restore: { input: object({ item }, ["item"]), output: written, errors },
    delete: { input: object({ item }, ["item"]), output: written, errors },
    /** Unchanged past either end of the list. */
    move: { input: object({ id: text, offset: { type: "integer", enum: [-1, 1] } }, ["id", "offset"]), output: written, errors },
    settings: { input: object({ settings: object(choices, []) }, ["settings"]), output: state, errors },
  },
  events: {
    /** The full state after changes. */
    changed: { schema: state },
  },
})
