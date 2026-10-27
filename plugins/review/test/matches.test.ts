import { expect, test } from "bun:test"
import { searchDiff } from "../src/matches"
import { parsePatch } from "../src/patch"
import { patch } from "./fixtures"

const files = [
  { file: "src/auth.ts", rows: parsePatch(patch) },
  { file: "src/ttl/config.ts", rows: parsePatch("@@ -0,0 +1,1 @@\n+export const TTL = 60\n") },
]
const show = (query: string) => searchDiff(query, files).matches.map((match) => match.kind === "file" ? `file ${match.file}` : `${match.file}:${match.line}${match.old ? " (old)" : ""} ${match.sign}${match.text}`)

test("files whose name matches come first, then those whose folders do, then the diff lines that match, removed ones included", () => {
  expect(show("ttl")).toEqual([
    "file src/ttl/config.ts",
    "src/auth.ts:3 (old) -const ttl = 3600",
    "src/auth.ts:2 +const ttl = Number(env.TTL ?? 3600)",
    "src/auth.ts:3 +if (!ttl) throw new Error(\"ttl\")",
    "src/ttl/config.ts:1 +export const TTL = 60",
  ])
  expect(show("config")).toEqual(["file src/ttl/config.ts"])
})

test("a capital letter makes the search case-sensitive, and an empty one finds nothing", () => {
  expect(show("TTL")).toEqual(["src/auth.ts:2 +const ttl = Number(env.TTL ?? 3600)", "src/ttl/config.ts:1 +export const TTL = 60"])
  expect(searchDiff("", files).matches).toEqual([])
})

test("lines past the limit are counted as cut off, and the match is located in the text", () => {
  const found = searchDiff("t", files, 2)
  expect(found.lines).toBe(2)
  expect(found.truncated).toBe(true)
  const [first] = searchDiff("Number", files).matches
  expect(first).toMatchObject({ kind: "line", start: 12, end: 18 })
})
