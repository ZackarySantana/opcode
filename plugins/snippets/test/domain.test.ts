import { expect, test } from "bun:test"
import { effectiveSnippets, findTokens, formatSnippet, parseSnippet, type Snippet } from "../src/domain"

const tokens = (text: string, known: (name: string) => boolean = () => true) => findTokens(text, known).map((token) => text.slice(token.start, token.end))

test.each([
  ["(#review) and [#hi], then #review again", ["#review", "#hi"]],
  ["#review. #hi, #a1!", ["#review", "#hi", "#a1"]],
  ["see https://x.dev/#review, a#review, ##review, [link](#review)", []],
  ["# review heading, #Review, #review-, #review_x, #café", []],
  ["#123 issue references", []],
  ["`#review` and ``a `#hi` b``", []],
  ["```\n#review\n```\n#hi", ["#hi"]],
  ["```\n#review\n```js\n#hi", []],
  ["```\nunterminated #review", []],
])("%j expands %j", (text, expected) => {
  expect(tokens(text)).toEqual(expected)
})

test("unknown names stay literal, and offsets are UTF-16 indices like host mentions", () => {
  expect(tokens("#unknown #hi", (name) => name === "hi")).toEqual(["#hi"])
  expect(findTokens("😀 #hi", () => true)).toEqual([{ name: "hi", start: 3, end: 6 }])
})

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
