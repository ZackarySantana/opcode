import { expect, test } from "bun:test"
import { formatReview, TOOL_NAME } from "../src/message"
import type { Comment } from "../src/review"

const header = (text: string) => text.split("\n\n")[0]!
const comment = (id: string, change: Partial<Comment> = {}): Comment => ({
  id, file: "src/auth.ts", side: "new", start: 41, end: 41, quote: ["+const ttl = 3600"], text: "Make this configurable.", created: 1, ...change,
})

test("each comment names its file, lines, and side, quotes a few lines, and asks for one reply with the tool", () => {
  const message = formatReview([
    comment("r1"),
    comment("r2", { start: 10, end: 16, quote: ["+a", "+b", "+c", "+d", "+e", "+f", "+g"] }),
    comment("r3", { side: "old", start: 3, end: 3, quote: ["-gone"], text: "Why remove this??" }),
  ], "This turn")!
  expect(message.text).toContain("(This turn)")
  expect(message.text).toContain(TOOL_NAME)
  expect(message.text).toContain("[r1] src/auth.ts:41\n> +const ttl = 3600\nMake this configurable.")
  expect(message.text).toContain("[r2] src/auth.ts:10-16\n> +a\n> +b\n> +c\n> +d\n> (3 more lines)")
  expect(message.text).toContain("[r3] src/auth.ts:3 (removed lines) [question]\n> -gone\nWhy remove this?")
  // Only a review with questions explains them, in its header.
  expect(header(message.text)).toContain("[question]")
  expect(message.ids).toEqual(["r1", "r2", "r3"])
  expect(message.metadata).toEqual({ "opcode-review": { comments: ["r1", "r2", "r3"] } })
})

test("comments past the length budget are left for the next message, and nothing to send is nothing", () => {
  const long = "x".repeat(15_000)
  const message = formatReview([comment("r1", { text: long }), comment("r2", { text: long })], "Session")!
  expect(message.ids).toEqual(["r1"])
  expect(header(message.text)).not.toContain("[question]")
  expect(formatReview([], "Session")).toBeUndefined()
})
