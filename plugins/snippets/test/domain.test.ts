import { expect, test } from "bun:test"
import { authoringRequest, effectiveSnippets, formatSnippet, parseCommand, parseSnippet, takenAliases, type Snippet } from "../src/domain"

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

test("frontmatter survives a byte order mark and unindented alias lists", () => {
  expect(parseSnippet("\uFEFF---\ndescription: Review\naliases: [rv]\n---\nbody")).toEqual({ description: "Review", aliases: ["rv"], body: "body" })
  expect(parseSnippet("---\naliases:\n- one\n- two\nother:\n- ignored\n---\nbody")).toEqual({ aliases: ["one", "two"], body: "body" })
})

test("aliases another snippet would keep are reported, but a project alias may override a global one", () => {
  const snippets = [snippet("taken", "global"), snippet("other", "global", ["rv"]), snippet("first", "project", ["fx"]), snippet("fresh", "project", ["old"])]
  const owners = (proposed: Snippet) => takenAliases(snippets, proposed).map(([alias, owner]) => [alias, owner.path])
  expect(owners(snippet("fresh", "project", ["taken", "rv", "fx", "new"]))).toEqual([["taken", "/global/taken.md"], ["fx", "/project/first.md"]])
  // The snippet's own earlier aliases don't count against it, and project snippets don't shadow a global write.
  expect(owners(snippet("fresh", "project", ["old"]))).toEqual([])
  expect(owners(snippet("wide", "global", ["fx", "first", "rv"]))).toEqual([["rv", "/global/other.md"]])
})

test("/snippets arguments start authoring only after new, with the rest as the request", () => {
  expect(parseCommand("new Never commit\nuntil I say so")).toEqual({ verb: "new", request: "Never commit\nuntil I say so" })
  expect(parseCommand("/snippets new")).toEqual({ verb: "new", request: "" })
  expect(parseCommand("")).toEqual({ verb: "open" })
  expect(parseCommand("newer")).toEqual({ verb: "open" })
})

test("an authoring request names the snippet it changes", () => {
  expect(authoringRequest({}, "says hi")).toEndWith("The user wants to create a snippet that says hi")
  expect(authoringRequest({ name: "review", scope: "project" }, "be shorter")).toEndWith("The user wants this change to @review: be shorter")
})
