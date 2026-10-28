import { expect, test } from "bun:test"
import { insertion, snippetOptions } from "../src/gui/options"
import type { SnippetEntry } from "../src/service"

const t = (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key
const row = (name: string, scope: SnippetEntry["scope"], extra: Partial<SnippetEntry> = {}): SnippetEntry =>
  ({ name, scope, path: `/${scope}/${name}.md`, aliases: [], body: `${name} body`, overridden: false, conflict: false, ...extra })

test("options list project snippets before global ones, searchable by summary, aliases, and flags", () => {
  const rows = [
    row("review", "global", { overridden: true }),
    row("plan", "global", { description: "Plan first", aliases: ["p", "pl"] }),
    row("review", "project", { body: `  Review\n\nthe ${"diff ".repeat(40)}` }),
    row("todo", "global", { conflict: true }),
  ]
  const options = snippetOptions(rows, t)
  expect(options.map((option) => [option.title, option.group, option.description])).toEqual([
    ["@review", "group.project", `Review the ${"diff ".repeat(40)}`.slice(0, 99) + "…"],
    ["@review", "group.global", "review body · flag.overridden"],
    ["@plan", "group.global", "Plan first · @p @pl"],
    ["@todo", "group.global", "todo body · flag.conflict"],
  ])
  expect(options[1]!.value).toEqual({ type: "snippet", snippet: rows[0]! })
})

test("the list for /snippets offers writing a new snippet first", () => {
  const options = snippetOptions([row("plan", "global")], t, { create: true })
  expect(options.map((option) => option.value.type)).toEqual(["new", "snippet"])
  expect(snippetOptions([], t, { create: true })).toHaveLength(1)
})

test("a pick inserts @name, unless another snippet or skill would answer to it", () => {
  expect(insertion(row("plan", "global"))).toEqual({ text: "@plan " })
  expect(insertion(row("plan", "global", { overridden: true }))).toEqual({ blocked: "overridden" })
  expect(insertion(row("plan", "global", { conflict: true }))).toEqual({ blocked: "conflict" })
})
