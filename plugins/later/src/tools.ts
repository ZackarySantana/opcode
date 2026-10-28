import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { object } from "@opcode/core/rpc"
import { findItem, type LaterItem } from "./domain"
import type { LaterService } from "./service"

const id = { type: "string", description: "The item's id, from later_list." }

/**
 * The user's Later list, for the agent. They change it through the same service as the terminals, which show each
 * change right away. Only deleting asks the user: an edit reports the previous text, and a completed item can be restored.
 */
export function laterTools(service: LaterService, assert: Plugin.Context["permission"]["assert"]) {
  const item = async (input: unknown) => {
    const { id } = input as { id: string }
    const found = await service.item(id)
    if (!found) throw new Error(`No Later item has id ${id}. Call later_list for current ids.`)
    return found
  }
  const changed = "The item changed while this ran; call later_list and try again."
  const tools = [
    {
      name: "later_list",
      description: "List the user's Later items: prompts they saved to come back to, in their order. Use these tools only when the user asks about their Later list.",
      input: object({ completed: { type: "boolean", description: "Also list completed items, newest first." } }, []),
      options: { codemode: false },
      execute: async (input: unknown) => {
        const { active, completed } = await service.state()
        const brief = (items: readonly LaterItem[]) => items.map(({ id, message }) => ({ id, message }))
        return { content: JSON.stringify((input as { completed?: boolean }).completed ? { active: brief(active), completed: brief(completed) } : { active: brief(active) }) }
      },
    },
    {
      name: "later_add",
      description: "Add an item to the end of the user's Later list.",
      input: object({ message: { type: "string", description: "The prompt to come back to, as the user would type it." } }, ["message"]),
      options: { codemode: false },
      execute: async (input: unknown) => ({ content: `Added ${(await service.add((input as { message: string }).message)).id}.` }),
    },
    {
      name: "later_edit",
      description: "Edit a Later item: replace its text, complete it (moving it to the user's history), or restore a completed one to the end of the list.",
      input: object({
        id,
        message: { type: "string", description: "The item's new text." },
        completed: { type: "boolean", description: "true completes an active item; false restores a completed one." },
      }, ["id"]),
      options: { codemode: false },
      execute: async (input: unknown) => {
        const { message, completed } = input as { message?: string; completed?: boolean }
        if (message === undefined && completed === undefined) throw new Error("Pass message, completed, or both.")
        let found = await item(input)
        const results: string[] = []
        if (message !== undefined) {
          const edited = await service.edit(found, message)
          if (!edited.changed) return { content: changed }
          // The transcript keeps the old text, so an unwanted edit can be undone.
          results.push(`Edited. Previous text: ${JSON.stringify(found.message)}.`)
          // What this edit wrote, not a re-read: a change by someone else since then still stops the next step.
          found = findItem(edited.state, found.id)!
        }
        if (completed !== undefined) {
          if (completed === (found.completedAt !== undefined)) results.push(completed ? "Already completed." : "Already active.")
          else if (!(completed ? await service.complete(found) : await service.restore(found)).changed) results.push(changed)
          else results.push(completed ? "Completed." : "Restored.")
        }
        return { content: results.join(" ") }
      },
    },
    {
      name: "later_delete",
      description: "Permanently delete a Later item, active or completed, after the user approves.",
      input: object({ id }, ["id"]),
      options: { codemode: false },
      execute: async (input: unknown, context: ToolContext) => {
        const found = await item(input)
        await assert({
          sessionID: context.sessionID, agent: context.agent, action: "later_delete",
          // The prompt shows the text; "always" allows every Later deletion, never a pattern made of item text.
          resources: [found.message], save: ["*"], metadata: { id: found.id },
          source: { type: "tool", messageID: context.messageID, id: context.id },
        })
        // Deletes only what the user approved: an edit while they decided leaves the item in place.
        return { content: (await service.delete(found)).changed ? "Deleted." : changed }
      },
    },
  ]
  // Sessions from before the user turned the tools off still list them, so every call reads the setting.
  return tools.map((tool) => ({
    ...tool,
    execute: async (input: unknown, context: ToolContext) =>
      await service.toolsDisabledAt() === undefined ? tool.execute(input, context) : { content: "The user turned off Later tools. They won't be available in new sessions." },
  }))
}
