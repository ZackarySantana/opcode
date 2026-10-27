import { expect, test } from "bun:test"
import { hunkStarts, lineOf, parsePatch, segments } from "../src/patch"
import { patch } from "./fixtures"

test("rows carry the lines each side shows, skipping file headers but not removed lines that look like them", () => {
  const rows = parsePatch(patch)
  expect(rows.map((row) => `${row.kind} ${lineOf(row)} ${row.text}`)).toEqual([
    "ctx 1 const user = load()",
    "del 2 -- a removed line that looks like a header",
    "del 3 const ttl = 3600",
    "add 2 const ttl = Number(env.TTL ?? 3600)",
    "add 3 if (!ttl) throw new Error(\"ttl\")",
    "ctx 4 export { user }",
    "ctx 21 function end() {",
    "del 21   return 1",
    "add 22   return 2",
  ])
  expect(hunkStarts(rows)).toEqual([0, 6])
})

test("splitting at comments keeps every row numbered as in the whole patch", () => {
  const rows = parsePatch(patch)
  const parts = segments(rows, new Set([2, 3]))
  // Breaks after rows 2 and 3, and at the hunk boundary.
  expect(parts.map((part) => [part.start, part.rows.length])).toEqual([[0, 3], [3, 1], [4, 2], [6, 3]])
  const reparsed = parts.flatMap((part) => parsePatch(part.patch).map((row) => ({ ...row, hunk: 0 })))
  expect(reparsed.map((row) => [row.kind, row.old, row.new, row.text])).toEqual(rows.map((row) => [row.kind, row.old, row.new, row.text]))
})

test("a new file numbers from its first line", () => {
  const rows = parsePatch("@@ -0,0 +1,2 @@\n+one\n+two\n")
  expect(rows.map(lineOf)).toEqual([1, 2])
  const [second] = segments(rows, new Set([0])).slice(1)
  expect(parsePatch(second!.patch).map(lineOf)).toEqual([2])
})

test("a blank context line that lost its leading space still counts as a line", () => {
  const rows = parsePatch("@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n")
  expect(rows.map((row) => [row.kind, lineOf(row)])).toEqual([["ctx", 1], ["ctx", 2], ["del", 3], ["add", 3]])
})
