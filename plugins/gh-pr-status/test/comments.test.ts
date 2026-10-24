import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { formatFeedback, type Feedback } from "../src/comments"
import { fetchFeedback, type Runner } from "../src/gh"
import { sendFeedback } from "../src/host"

const url = "https://github.com/acme/web/pull/42"
const user = (login: string) => ({ __typename: "User", login })
const bot = { __typename: "Bot", login: "ci-bot" }
let ids = 100
const comment = (author: object, body: string, extra: object = {}) => ({ author, body, url: `${url}#discussion_r${++ids}`, ...extra })
const thread = (comments: object[], extra: object = {}) =>
  ({ isResolved: false, isOutdated: false, path: "src/cache.ts", line: 91, startLine: 88, originalLine: 91, originalStartLine: 88, comments: { nodes: comments }, ...extra })

const view = JSON.stringify({ number: 42, title: "Cache build artifacts", url, headRefName: "cache-artifacts", state: "OPEN" })
const response = JSON.stringify({ data: { viewer: { login: "me" }, repository: { pullRequest: {
  reviewThreads: { nodes: [
    thread([comment(user("alice"), "Evict before insert?\r\nOtherwise this grows."), comment(user("me"), "Size is bounded by the key space.")]),
    thread([comment(user("bob"), "Rename this.", { diffHunk: "@@ -1,6 +1,6 @@\n a\n b\n-c\n+d\n e" })], { isOutdated: true, line: null, startLine: null, originalStartLine: null, originalLine: 12 }),
    thread([comment(user("alice"), "Done?")], { isResolved: true }),
    thread([comment(user("me"), "Note to self")]),
    thread([comment(bot, "Coverage dropped")]),
    thread([comment(user("carol"), "Why sync?"), ...["a", "b", "c", "d", "e"].map((body) => comment(user(body === "c" ? "me" : "dave"), body)), comment(bot, "noise")], { path: "src/io.ts", line: 7, startLine: null }),
  ] },
  reviews: { nodes: [
    { ...comment(user("alice"), "Mostly good, see the cache comment."), state: "CHANGES_REQUESTED" },
    { ...comment(user("bob"), ""), state: "APPROVED" },
    { ...comment(user("me"), "Self-review"), state: "COMMENTED" },
    { ...comment(user("erin"), "Draft"), state: "PENDING" },
    { ...comment(bot, "Automated summary"), state: "COMMENTED" },
  ] },
  comments: { nodes: [comment(user("me"), "Ready for another look"), comment(user("frank"), "Does this need a changelog?")] },
} } } })

const runner = (calls: (string | undefined)[] = [], feedback = response): Runner => async (args, _signal, cwd) => {
  calls.push(cwd)
  return { stdout: args[0] === "pr" ? view : feedback, stderr: "", status: 0 }
}
const signal = new AbortController().signal

test("sends unresolved feedback from others, anchored to code, and leaves out what isn't theirs to act on", async () => {
  const { text } = formatFeedback(await fetchFeedback(runner(), signal, "/repo"), "Review {branch} (#{pr}).")
  expect(text).toBe(`Review cache-artifacts (#42).

PR #42: Cache build artifacts
${url}
Included 3 threads, 1 review, 1 comment; left out 1 resolved, 3 yours, 3 from bots.

## 1. src/cache.ts:88-91 ${url}#discussion_r101
alice: Evict before insert?
Otherwise this grows.
you: Size is bounded by the key space.

## 2. src/cache.ts (outdated; was line 12) ${url}#discussion_r103
\`\`\`diff
 b
-c
+d
 e
\`\`\`
bob: Rename this.

## 3. src/io.ts:7 ${url}#discussion_r107
carol: Why sync?
(2 replies omitted, ${url}#discussion_r108)
you: c
dave: d
dave: e

## 4. Review by alice (changes requested) ${url}#discussion_r114
Mostly good, see the cache comment.

## 5. Comment by frank ${url}#discussion_r120
Does this need a changelog?`)
})

test("caps each comment and the whole text, counting what was left out; sends nothing when nothing is left", () => {
  const base: Feedback = { viewer: "me", pr: { number: 42, title: "t", url, branch: "b" }, threads: [], reviews: [], comments: [] }
  const long = { author: "alice", bot: false, body: "x".repeat(2000), url }
  const { text, summary } = formatFeedback({ ...base, comments: Array.from({ length: 40 }, () => long) })
  expect(summary).toBe("Included 24 comments; left out 16 over the length limit.")
  expect(text).toContain(`${"x".repeat(1500)}... (truncated, ${url})\n\n## 2.`)
  expect(formatFeedback({ ...base, comments: [{ ...long, author: "Me" }] })).toEqual({ summary: "Included nothing; left out 1 yours." })
})

test("a branch without an open pull request fails with the reason", async () => {
  const none: Runner = async () => ({ stdout: "", stderr: "no pull requests found for branch \"main\"\n", status: 1 })
  await expect(fetchFeedback(none, signal, "/repo")).rejects.toThrow("no pull requests found for branch \"main\"")
  const merged: Runner = async () => ({ stdout: JSON.stringify({ number: 7, title: "t", url, headRefName: "main", state: "MERGED" }), stderr: "", status: 0 })
  await expect(fetchFeedback(merged, signal, "/repo")).rejects.toThrow("no open pull request for branch \"main\" (#7 is merged)")
})

test("/ghpr-comments reads the open session's directory and sends the feedback to that session as a prompt", async () => {
  const toasts: string[] = []
  const prompts: { sessionID: string; text: string }[] = []
  let route: ReturnType<Context["ui"]["router"]["current"]> = { type: "home" }
  const api = {
    ui: { router: { current: () => route }, toast: { show: ({ message }: { message: string }) => toasts.push(message) } },
    client: { session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, location: { directory: "/work/web" } }),
      prompt: async (input: { sessionID: string; text: string }) => { prompts.push(input) },
    } },
  } as unknown as Pick<Context, "client" | "ui">
  await sendFeedback(api, signal)
  expect(toasts).toEqual(["Open a session first: /ghpr-comments sends to the open session."])

  route = { type: "session", sessionID: "ses_1" }
  const directories: (string | undefined)[] = []
  await sendFeedback(api, signal, undefined, runner(directories))
  expect(directories).toEqual(["/work/web", "/work/web"])
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatchObject({ sessionID: "ses_1", text: expect.stringMatching(/^The branch cache-artifacts got reviewed/) })
  expect(toasts.at(-1)).toStartWith("Sent review comments.")

  const nothing = JSON.stringify({ data: { viewer: { login: "me" }, repository: { pullRequest: { reviewThreads: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } } } } })
  await sendFeedback(api, signal, undefined, runner([], nothing))
  expect(prompts).toHaveLength(1)
  expect(toasts.at(-1)).toBe("No review comments to send. Included nothing.")
})
