import { expect, test } from "bun:test"
import { effectiveSnippets, formatSnippet, parseSnippet, type Snippet } from "../src/domain"

const snippet = (name: string, scope: Snippet["scope"], aliases: string[] = []): Snippet => ({ name, scope, aliases, body: `${scope} ${name}`, path: `/${scope}/${name}.md` })

test("project snippets override global ones, and names win over aliases", () => {
  const keys = effectiveSnippets([
    snippet("shared", "global", ["g"]), snippet("other", "global", ["shared-alias", "taken"]),
    snippet("shared", "project", ["p"]), snippet("taken", "global"),
  ])
  expect(Object.fromEntries([...keys].map(([key, value]) => [key, value.path]))).toEqual({
    shared: "/project/shared.md", other: "/global/other.md", taken: "/global/taken.md",
    p: "/project/shared.md", "shared-alias": "/global/other.md",
  })
})

test("frontmatter round-trips, including bodies that look like frontmatter, and hand-written alias lists are accepted", () => {
  for (const fields of [{ description: "Say: \"hi\"", aliases: ["hey", "yo"], body: "Body\n\n---\nmore" }, { aliases: [], body: "---\nnot: frontmatter\n---\nrest" }]) {
    expect(parseSnippet(formatSnippet(fields))).toEqual(fields)
  }
  expect(parseSnippet("plain body\n")).toEqual({ aliases: [], body: "plain body" })
  expect(parseSnippet("---\ndescription: Plain: text\naliases:\n  - one\n  - Bad Name\nother: x\n---\nbody")).toEqual({ description: "Plain: text", aliases: ["one"], body: "body" })
  expect(parseSnippet("---\naliases: one, 'two'\n---\nbody")).toEqual({ aliases: ["one", "two"], body: "body" })
})
