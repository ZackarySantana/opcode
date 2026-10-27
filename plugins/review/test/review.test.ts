import { expect, test } from "bun:test"
import { parsePatch } from "../src/patch"
import { addComment, anchorOf, confirm, delivery, drafts, editComment, emptyReview, isViewed, locate, markSent, removeComment, toggleViewed, unconfirmed, unsend } from "../src/review"
import { patch } from "./fixtures"

const rows = parsePatch(patch)

test("a range with any new line anchors to new lines; only removed lines anchor to old ones", () => {
  expect(anchorOf("src/auth.ts", rows, 4, 2)).toEqual({
    file: "src/auth.ts", side: "new", start: 2, end: 3,
    quote: ["-const ttl = 3600", "+const ttl = Number(env.TTL ?? 3600)", "+if (!ttl) throw new Error(\"ttl\")"],
  })
  expect(anchorOf("src/auth.ts", rows, 1, 2)).toMatchObject({ side: "old", start: 2, end: 3 })
})

test("comments follow their text when lines move, prefer the nearest copy, and drop out when the text is gone", () => {
  const review = addComment(emptyReview, anchorOf("src/auth.ts", rows, 3, 3), "Use config", 1)
  const comment = review.comments[0]!
  expect(comment.id).toBe("r1")
  expect(locate(comment, rows)).toEqual({ from: 3, to: 3 })

  // Two lines inserted above it: same text, new place.
  const shifted = parsePatch(patch.replace(" const user = load()", " const user = load()\n+// one\n+// two").replace("@@ -1,4 +1,5 @@", "@@ -1,4 +1,7 @@"))
  expect(locate(comment, shifted)).toEqual({ from: 5, to: 5 })

  // The same text further away loses to the copy near the comment's line.
  const duplicated = parsePatch(`@@ -1,1 +1,3 @@\n+const ttl = Number(env.TTL ?? 3600)\n context\n@@ -40,1 +40,2 @@\n x\n+const ttl = Number(env.TTL ?? 3600)\n`)
  expect(locate({ ...comment, start: 41 }, duplicated)).toEqual({ from: 3, to: 3 })

  expect(locate(comment, parsePatch("@@ -1,1 +1,1 @@\n-a\n+b\n"))).toBeUndefined()
})

test("a file stays viewed until its patch changes", () => {
  const viewed = toggleViewed(emptyReview, "turn", "src/auth.ts", patch)
  expect(isViewed(viewed, "turn", "src/auth.ts", patch)).toBe(true)
  expect(isViewed(viewed, "working", "src/auth.ts", patch)).toBe(false)
  expect(isViewed(viewed, "turn", "src/auth.ts", `${patch}+more\n`)).toBe(false)
  expect(isViewed(toggleViewed(viewed, "turn", "src/auth.ts", patch), "turn", "src/auth.ts", patch)).toBe(false)
})

test("comments are drafts until sent, wait while the agent hasn't taken them, and return to drafts when cancelled", () => {
  let review = addComment(addComment(emptyReview, anchorOf("a", rows, 0, 0), "one", 1), anchorOf("a", rows, 5, 5), "two", 2)
  review = markSent(review, ["r1"], "msg_1", 3)
  expect(drafts(review).map((comment) => comment.id)).toEqual(["r2"])
  const [first] = review.comments
  expect(delivery(first!, new Set(), new Set(["msg_1"]))).toBe("sending")
  expect(delivery(first!, new Set(), new Set())).toBe("unconfirmed")
  expect(unconfirmed(review).map((group) => [group.messageID, group.comments.map((comment) => comment.id)])).toEqual([["msg_1", ["r1"]]])

  review = confirm(review, "msg_1")
  expect(unconfirmed(review)).toEqual([])
  expect(delivery(review.comments[0]!, new Set(["msg_1"]), new Set())).toBe("pending")
  expect(delivery(review.comments[0]!, new Set(), new Set())).toBe("sent")

  // What the agent read can't change under it.
  expect(editComment(review, "r1", "changed").comments[0]!.text).toBe("one")
  expect(removeComment(review, "r1").comments).toHaveLength(2)

  review = unsend(review, "msg_1")
  expect(drafts(review).map((comment) => comment.id)).toEqual(["r1", "r2"])
})
