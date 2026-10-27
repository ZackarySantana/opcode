import { expect, test } from "bun:test"
import { arrangeReferences, type DiffFile } from "../src/usages"
import type { Place } from "../src/references"

const place = (file: string, line: number, text: string, name = "load"): Place => ({ file, line, column: Math.max(0, text.indexOf(name)), text })

// load gains a parameter in api.ts; app.ts updates one call and leaves another; cli.ts isn't touched.
const diff: DiffFile[] = [
  { file: "src/api.ts", patch: "@@ -1,3 +1,3 @@\n-export function load(id) {\n+export function load(id, options) {\n   return fetch(id)\n }\n" },
  { file: "src/app.ts", patch: "@@ -10,2 +10,2 @@\n-const user = load(id)\n+const user = load(id, {})\n const other = 1\n" },
]
const places = [
  place("src/cli.ts", 4, "  load(argv[0])"),
  place("src/app.ts", 30, "  return load(next)"),
  place("src/app.ts", 10, "const user = load(id, {})"),
  place("src/api.ts", 1, "export function load(id, options) {"),
  place("src/app.ts", 10, "const user = load(id, {})"),
]

const summary = (list: ReturnType<typeof arrangeReferences>) =>
  list.groups.map((group) => [group.file, group.touched, group.references.map((reference) => `${reference.line}:${reference.mark}${reference.definition ? ":def" : ""}${reference.notUpdated ? ":stale" : ""}`)])

test("references are marked against the diff, definitions first, then touched files with the current one leading", () => {
  const list = arrangeReferences("load", places, diff, { scope: "all", current: "src/app.ts" })
  expect(summary(list)).toEqual([
    ["src/api.ts", true, ["1:changed:def"]],
    ["src/app.ts", true, ["10:changed", "30:diffed:stale"]],
    ["src/cli.ts", false, ["4:outside:stale"]],
  ])
  expect(list.counts).toEqual({ total: 4, inDiff: 3, outside: 1 })
  expect(list.signatureChanged).toBe(true)
  expect(list.removed).toBe(false)
  expect(list.unused).toBe(false)
})

test("the current file leads the touched files even when another sorts first", () => {
  const touched = [{ file: "a.ts", patch: "@@ -1,1 +1,1 @@\n-x\n+y\n" }, { file: "b.ts", patch: "@@ -1,1 +1,1 @@\n-x\n+y\n" }]
  const found = [place("a.ts", 5, "load()"), place("b.ts", 5, "load()"), place("c.ts", 1, "load()")]
  expect(arrangeReferences("load", found, touched, { scope: "all", current: "b.ts" }).groups.map((group) => group.file)).toEqual(["b.ts", "a.ts", "c.ts"])
})

test("a scope filters the groups but keeps the counts and flags over everything", () => {
  const all = arrangeReferences("load", places, diff, { scope: "all" })
  const inDiff = arrangeReferences("load", places, diff, { scope: "diff" })
  const outside = arrangeReferences("load", places, diff, { scope: "outside" })
  expect(summary(inDiff).map(([file]) => file)).toEqual(["src/api.ts", "src/app.ts"])
  expect(summary(outside)).toEqual([["src/cli.ts", false, ["4:outside:stale"]]])
  for (const list of [inDiff, outside]) {
    expect(list.counts).toEqual(all.counts)
    expect(list.signatureChanged).toBe(true)
  }
})

test("a definition that only moves or respaces leaves its callers alone", () => {
  const respaced = [{ file: "src/api.ts", patch: "@@ -1,1 +1,1 @@\n-export function load(id) {\n+  export  function load(id) {\n" }]
  const list = arrangeReferences("load", places, respaced, { scope: "all" })
  expect(list.signatureChanged).toBe(false)
  expect(list.groups.flatMap((group) => group.references).some((reference) => reference.notUpdated)).toBe(false)
})

test("removing the definition flags every use the change didn't touch", () => {
  const gone = [{ file: "src/api.ts", patch: "@@ -1,3 +1,0 @@\n-export function load(id) {\n-  return fetch(id)\n-}\n" }]
  const list = arrangeReferences("load", [place("src/cli.ts", 4, "  load(argv[0])")], gone, { scope: "all" })
  expect(list.removed).toBe(true)
  expect(list.signatureChanged).toBe(false)
  expect(summary(list)).toEqual([["src/cli.ts", false, ["4:outside:stale"]]])
})

test("a new definition nobody uses is unused, until something calls it", () => {
  const added = [{ file: "src/util.ts", patch: "@@ -1,0 +1,1 @@\n+export const slugify = (text) => text.toLowerCase()\n" }]
  const definition = place("src/util.ts", 1, "export const slugify = (text) => text.toLowerCase()", "slugify")
  expect(arrangeReferences("slugify", [definition], added, { scope: "all" }).unused).toBe(true)
  const used = [definition, place("src/app.ts", 3, "slugify(title)", "slugify")]
  expect(arrangeReferences("slugify", used, added, { scope: "all" }).unused).toBe(false)
  // A definition that already existed isn't new, so it isn't flagged.
  expect(arrangeReferences("slugify", [definition], [], { scope: "all" }).unused).toBe(false)
})
