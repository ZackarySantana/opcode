import { Rpc } from "@opencode/plugin/rpc"
import type { OpenCodeClient } from "@opencode/client"
import { PLUGIN_ID, replyStatuses, type Reply } from "./review"

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false })
const text = { type: "string" } as const
// Undeclared handler errors reach clients only as a generic rpc.internal failure.
const errors = { failed: object({}, []) }
const reply = object({ status: { type: "string", enum: replyStatuses }, reply: text, at: { type: "number" } }, ["status", "reply", "at"])

export const ReviewRpc = Rpc.define({
  id: PLUGIN_ID,
  events: {},
  methods: {
    replies: { errors, input: object({ sessionID: text }, ["sessionID"]), output: object({ replies: { type: "object", additionalProperties: reply } }, ["replies"]) },
  },
})

/** The agent's replies to a session's comments, by comment ID, from the server that recorded them. */
export function repliesRemote(client: Pick<OpenCodeClient, "rpc">) {
  const rpc = client.rpc(ReviewRpc)
  return async (sessionID: string, directory: string, signal: AbortSignal): Promise<Record<string, Reply>> =>
    (await rpc.replies({ sessionID }, { location: { directory }, signal }) as { replies: Record<string, Reply> }).replies
}
