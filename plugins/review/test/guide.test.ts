import { expect, test } from "bun:test"
import { guidePrompt, parseGuide } from "../src/guide"
import { parsePatch } from "../src/patch"
import { patch } from "./fixtures"

const rows = parsePatch(patch)
const rowsOf = (file: string) => file === "src/auth.ts" ? rows : undefined
const reply = (guide: unknown) => `Here's the walk.\n\n\`\`\`json\n${JSON.stringify(guide)}\n\`\`\`\n`

test("a reply's steps are anchored to the diff rows they name, in its order, removed lines included", () => {
  const guide = parseGuide(reply({
    summary: "Reads the TTL from the environment.",
    steps: [
      { file: "src/auth.ts", start: 2, end: 3, title: "TTL from env", note: "Zero throws." },
      { file: "src/auth.ts", start: 3, end: 3, side: "old", title: "Old constant", note: "Gone." },
    ],
    skipped: [{ file: "package-lock.json", why: "generated" }],
  }), rowsOf)!
  expect(guide.summary).toBe("Reads the TTL from the environment.")
  expect(guide.steps.map((step) => [step.title, step.anchor.side, step.anchor.start, step.anchor.end, step.anchor.quote])).toEqual([
    ["TTL from env", "new", 2, 3, ["+const ttl = Number(env.TTL ?? 3600)", "+if (!ttl) throw new Error(\"ttl\")"]],
    ["Old constant", "old", 3, 3, ["-const ttl = 3600"]],
  ])
  expect(guide.skipped).toEqual([{ file: "package-lock.json", why: "generated" }])
})

test("steps on files the diff doesn't change are dropped, lines it doesn't show land on the nearest row, and a reply without a guide is none", () => {
  const guide = parseGuide(reply({ summary: "", steps: [
    { file: "src/other.ts", start: 1, title: "Not changed" },
    { file: "a/src/auth.ts", start: 40, end: 45, title: "Far below" },
  ] }), rowsOf)!
  expect(guide.steps.map((step) => [step.title, step.anchor.file, step.anchor.quote])).toEqual([["Far below", "src/auth.ts", ["+  return 2"]]])
  expect(parseGuide("I couldn't read the files.", rowsOf)).toBeUndefined()
  expect(parseGuide(reply({ steps: [{ file: "src/other.ts", start: 1 }] }), rowsOf)).toBeUndefined()
  // Braces without a fence still count.
  expect(parseGuide(`{"steps": [{"file": "src/auth.ts", "start": 2, "title": "Bare"}]}`, rowsOf)?.steps[0]?.title).toBe("Bare")
})

test("the prompt carries the diff, and lists the files too large to fit for the model to read itself", () => {
  const text = guidePrompt({ view: "Uncommitted", files: [
    { file: "src/auth.ts", patch, additions: 3, deletions: 3 },
    { file: "package-lock.json", patch: "x".repeat(70_000), additions: 900, deletions: 10 },
  ] })
  expect(text).toContain("(Uncommitted)")
  expect(text).toContain("--- src/auth.ts\nIndex: src/auth.ts")
  expect(text).toContain("+const ttl = Number(env.TTL ?? 3600)")
  expect(text).toContain("too large to include here; read them if they matter: package-lock.json (+900 -10)")
  expect(text).not.toContain("xxxxxxxxxx")
})
