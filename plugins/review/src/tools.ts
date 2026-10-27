import type { ToolContext } from "@opencode/plugin/promise/tool"
import { TOOL_NAME } from "./message"
import type { ReviewRecords } from "./records"
import { replyStatuses, type ReplyStatus } from "./review"

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false })

/** One small tool, listed only in sessions that were sent review comments. */
export function replyTool(records: ReviewRecords, now: () => number = Date.now) {
  return {
    name: TOOL_NAME,
    description: "Answer the user's review comments by id (like r3). Once per batch, after addressing them.",
    input: object({
      replies: {
        type: "array",
        minItems: 1,
        items: object({
          id: { type: "string" },
          status: { type: "string", enum: replyStatuses, description: "done: changed the code. answered: a question, no edit. declined: won't change it." },
          reply: { type: "string", description: "One sentence." },
        }, ["id", "status", "reply"]),
      },
    }, ["replies"]),
    options: { codemode: false },
    execute: async (input: unknown, context: ToolContext) => {
      const { replies } = input as { replies: { id: string; status: ReplyStatus; reply: string }[] }
      const unknown = await records.reply(context.sessionID, replies, now())
      const recorded = replies.length - unknown.length
      return { content: `Recorded ${recorded} ${recorded === 1 ? "reply" : "replies"}.${unknown.length ? ` No comment has id ${unknown.join(", ")}.` : ""}` }
    },
  }
}
