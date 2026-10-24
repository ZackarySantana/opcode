import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { LaterDatabase } from "./sqlite"

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false })
const id = { type: "string", description: "The item's id, from later_list." }

/**
 * The user's Later list, for the agent. They share the terminal's database, which shows changes within a poll.
 * Only deleting asks the user: a completed item can be restored from history.
 */
export function laterTools(database: LaterDatabase, assert: Plugin.Context["permission"]["assert"]) {
  const item = (input: unknown) => {
    const { id } = input as { id: string }
    const found = database.get(id)
    if (!found) throw new Error(`No Later item has id ${id}. Call later_list for current ids.`)
    return found
  }
  const changed = "The item changed while this ran; call later_list and try again."
  return [
    {
      name: "later_list",
      description: "List the user's Later items: prompts they saved to come back to, in their order. Use these tools only when the user asks about their Later list.",
      input: object({ completed: { type: "boolean", description: "Also list completed items, newest first." } }, []),
      options: { codemode: false },
      execute: async (input: unknown) => {
        const { active, completed } = database.snapshot()
        const brief = (items: typeof active) => items.map(({ id, message }) => ({ id, message }))
        return { content: JSON.stringify((input as { completed?: boolean }).completed ? { active: brief(active), completed: brief(completed) } : { active: brief(active) }) }
      },
    },
    {
      name: "later_add",
      description: "Add an item to the end of the user's Later list.",
      input: object({ message: { type: "string", description: "The prompt to come back to, as the user would type it." } }, ["message"]),
      options: { codemode: false },
      execute: async (input: unknown) => ({ content: `Added ${database.add((input as { message: string }).message)}.` }),
    },
    {
      name: "later_complete",
      description: "Mark an active Later item complete, moving it to the user's history.",
      input: object({ id }, ["id"]),
      options: { codemode: false },
      execute: async (input: unknown) => {
        const found = item(input)
        if (found.completedAt !== undefined) return { content: "Already completed." }
        return { content: database.complete(found) ? "Completed." : changed }
      },
    },
    {
      name: "later_delete",
      description: "Permanently delete a Later item, active or completed, after the user approves.",
      input: object({ id }, ["id"]),
      options: { codemode: false },
      execute: async (input: unknown, context: ToolContext) => {
        const found = item(input)
        await assert({
          sessionID: context.sessionID, agent: context.agent, action: "later_delete",
          // The prompt shows the text; "always" allows every Later deletion, never a pattern made of item text.
          resources: [found.message], save: ["*"], metadata: { id: found.id },
          source: { type: "tool", messageID: context.messageID, id: context.id },
        })
        // Deletes only what the user approved: an edit while they decided leaves the item in place.
        return { content: database.delete(found) ? "Deleted." : changed }
      },
    },
  ]
}
