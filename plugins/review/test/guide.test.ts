import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { promptMetadata, promptOf } from "../src/ask"
import { activityOf, guidePrompt, parseDeck } from "../src/guide"
import { parsePatch } from "../src/patch"
import { patch } from "./fixtures"

const rows = parsePatch(patch)
const rowsOf = (file: string) => file === "src/auth.ts" ? rows : undefined
const reply = (deck: unknown) => `Here are the slides.\n\n\`\`\`json\n${JSON.stringify(deck)}\n\`\`\`\n`

test("a reply's slides keep their order, each with its code anchored to the diff rows it names, removed lines included", () => {
  const deck = parseDeck(reply({
    title: "Env TTL",
    slides: [
      { title: "Overview", body: "Reads the TTL from the environment." },
      { title: "The new TTL", body: "Zero throws.", code: [{ file: "src/auth.ts", start: 2, end: 3 }, { file: "src/auth.ts", start: 3, side: "old" }] },
    ],
    skipped: [{ file: "package-lock.json", why: "generated" }],
  }), rowsOf)!
  expect(deck.title).toBe("Env TTL")
  expect(deck.slides.map((slide) => [slide.title, slide.body, slide.code.map((code) => [code.side, code.start, code.end, code.quote])])).toEqual([
    ["Overview", "Reads the TTL from the environment.", []],
    ["The new TTL", "Zero throws.", [
      ["new", 2, 3, ["+const ttl = Number(env.TTL ?? 3600)", "+if (!ttl) throw new Error(\"ttl\")"]],
      ["old", 3, 3, ["-const ttl = 3600"]],
    ]],
  ])
  expect(deck.skipped).toEqual([{ file: "package-lock.json", why: "generated" }])
})

test("code from files the diff doesn't change is dropped, lines it doesn't show land on the nearest row, and a reply without slides is none", () => {
  const deck = parseDeck(reply({ slides: [{ title: "Far", body: "b", code: [{ file: "src/other.ts", start: 1 }, { file: "a/src/auth.ts", start: 40, end: 45 }] }] }), rowsOf)!
  expect(deck.slides[0]!.code.map((code) => [code.file, code.quote])).toEqual([["src/auth.ts", ["+  return 2"]]])
  expect(parseDeck("I couldn't read the files.", rowsOf)).toBeUndefined()
  expect(parseDeck(reply({ slides: [{}] }), rowsOf)).toBeUndefined()
  // Braces without a fence still count.
  expect(parseDeck(`{"slides": [{"title": "Bare", "body": "b"}]}`, rowsOf)?.slides[0]?.title).toBe("Bare")
})

test("the live log reads the model's tools, thinking, and the slides it has written so far", () => {
  const messages = [
    { id: "msg_q", type: "user", text: "...", metadata: promptMetadata("msg_q"), time: { created: 1 } },
    { id: "msg_a", type: "assistant", agent: "build", model: { id: "m", providerID: "p" }, time: { created: 2 }, content: [
      { type: "reasoning", text: "Start with the config." },
      { type: "tool", id: "t1", name: "read", state: { status: "completed", input: { path: "/home/me/repo/src/deep/config.ts" } } },
      { type: "tool", id: "t2", name: "grep", state: { status: "running", input: { pattern: "ttl", path: "src" } } },
      { type: "text", text: '```json\n{"title": "Deck", "slides": [{"title": "Overview", "body": "x"}, {"title": "The \\"new\\" TTL", "bo' },
    ] },
  ] as unknown as SessionMessageInfo[]
  expect(activityOf(messages, "msg_q", promptOf)).toEqual([
    { kind: "thinking", text: "Start with the config." },
    { kind: "tool", text: "Reading …/deep/config.ts" },
    { kind: "tool", text: 'Searching for "ttl" in src' },
    { kind: "slide", text: "Overview" },
    { kind: "slide", text: 'The "new" TTL' },
  ])
  expect(activityOf(messages, "msg_other", promptOf)).toEqual([])
})

test("the prompt asks for slides by idea, carries the diff, and lists the files too large to fit", () => {
  const text = guidePrompt({ view: "Uncommitted", files: [
    { file: "src/auth.ts", patch, additions: 3, deletions: 3 },
    { file: "package-lock.json", patch: "x".repeat(70_000), additions: 900, deletions: 10 },
  ] })
  expect(text).toContain("slide deck")
  expect(text).toContain("by idea, not by file")
  expect(text).toContain("--- src/auth.ts\nIndex: src/auth.ts")
  expect(text).toContain("too large to include here; read them if they matter: package-lock.json (+900 -10)")
  expect(text).not.toContain("xxxxxxxxxx")
})
