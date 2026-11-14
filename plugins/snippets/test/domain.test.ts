import { expect, test } from "bun:test"
import { askFirst, formatShared, newlyBroken, parseShared, referenceSegments, effectiveSnippets, expandSnippet, expandWrite, formatSnippet, MAX_BODY, parseCommand, parseSnippet, referenceKeys, referenceProblems, takenAliases, type Snippet } from "../src/domain"

const snippet = (name: string, scope: Snippet["scope"], aliases: string[] = [], body = `${scope} ${name}`): Snippet => ({ name, scope, aliases, body, path: `/${scope}/${name}.md` })
const expand = (snippets: Snippet[], name: string, blocked?: Set<string>) => {
  const keys = referenceKeys(snippets, blocked)
  return expandSnippet(keys.get(name)!, keys)
}

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

test("/snippets new opens the editor, save carries the request, and anything else opens the list", () => {
  expect(parseCommand("new")).toEqual({ verb: "new" })
  expect(parseCommand("/snippets save  the handoff\nabove ")).toEqual({ verb: "save", request: "the handoff\nabove" })
  expect(parseCommand("")).toEqual({ verb: "open" })
  expect(parseCommand("newer")).toEqual({ verb: "open" })
})

test("agents ask before snippet writes and deletes unless they already have a rule for them", () => {
  const rules = [{ action: "*", resource: "*", effect: "deny" }]
  askFirst(rules)
  // Added first, so the agent's own rules after them, such as a deny, still win.
  expect(rules).toEqual([
    { action: "snippet_write", resource: "*", effect: "ask" }, { action: "snippet_delete", resource: "*", effect: "ask" }, { action: "*", resource: "*", effect: "deny" },
  ])
  const configured = [{ action: "snippet_write", resource: "*", effect: "allow" }]
  askFirst(configured)
  expect(configured).toEqual([{ action: "snippet_delete", resource: "*", effect: "ask" }, { action: "snippet_write", resource: "*", effect: "allow" }])
})

test("references expand in place through nested snippets, by name or alias, with project snippets in place of global ones", () => {
  const snippets = [
    snippet("ticket", "global", [], "Do the ticket, then:\n\n@review\n\nThanks @rv."),
    snippet("review", "global", ["rv"], "GLOBAL REVIEW"),
    snippet("review", "project", ["rv"], "Review with @style"),
    snippet("style", "global", [], "STYLE"),
  ]
  expect(expand(snippets, "ticket")).toEqual({
    text: "Do the ticket, then:\n\nReview with STYLE\n\nThanks @rv.", missing: [], cycles: [], tooLarge: false,
  })
  // `@rv.` is not a mention, and neither are emails, paths, or names another skill owns.
  expect(expand([snippet("a", "global", [], "mail me@b.com, read @b/x and @report @b"), snippet("b", "global"), snippet("report", "global")], "a", new Set(["report"])))
    .toEqual({ text: "mail me@b.com, read @b/x and @report global b", missing: ["report"], cycles: [], tooLarge: false })
})

test("unknown references, loops, and oversized expansions stay as typed and are reported", () => {
  const loop = [snippet("a", "global", [], "A @b @nobody"), snippet("b", "global", [], "B @a"), snippet("c", "global", [], "C @c")]
  const looped = expand(loop, "a")
  expect(looped).toEqual({ text: "A B @a @nobody", missing: ["nobody"], cycles: [["b", "a"]], tooLarge: false })
  expect(referenceProblems(looped)).toEqual(["@nobody is not a snippet.", "@b → @a loops back to a snippet already being expanded."])
  expect(expand(loop, "c").text).toBe("C @c")
  // Each level doubles the text, so the expansion stops at the limit rather than building all of it.
  const big = "x".repeat(MAX_BODY / 2)
  const doubling = [snippet("l0", "global", [], big), ...Array.from({ length: 40 }, (_, i) => snippet(`l${i + 1}`, "global", [], `@l${i} @l${i}`))]
  expect(expand(doubling, "l40")).toEqual({ text: "@l39 @l39", missing: [], cycles: [], tooLarge: true })
  expect(expand(doubling, "l0").tooLarge).toBe(false)
})

test("a snippet about to be written expands with its new text, and a global one sees global snippets only", () => {
  const snippets = [snippet("review", "global", [], "Review, then @ticket"), snippet("ticket", "global", [], "OLD"), snippet("local", "project")]
  expect(expandWrite(snippets, snippet("ticket", "global", [], "Ticket: @review")).cycles).toEqual([["review", "ticket"]])
  expect(expandWrite(snippets, snippet("ticket", "global", [], "@local")).missing).toEqual(["local"])
  expect(expandWrite(snippets, snippet("ticket", "project", [], "@local")).text).toBe("project local")
})

test("removing or renaming a snippet reports the snippets whose references stop resolving", () => {
  const review = snippet("review", "project", ["rv"])
  const snippets = [snippet("ticket", "global", [], "@review"), snippet("alias", "global", [], "@rv"), review, snippet("review", "global"), snippet("other", "global", [], "@gone")]
  const without = (removed: Snippet) => snippets.filter((other) => other !== removed)
  // Without the project review, @review still finds the global one, but @rv no longer resolves.
  expect(newlyBroken(snippets, without(review)).map((s) => s.name)).toEqual(["alias"])
  expect(newlyBroken(snippets, without(snippets[3]!))).toEqual([])
  // A rename that keeps the alias breaks nothing.
  expect(newlyBroken(snippets, [...without(review), snippet("check", "project", ["rv"])])).toEqual([])
})

test("references to snippets are split out for coloring; other @words, emails, and paths stay plain text", () => {
  const known = new Set(["review", "rv"])
  expect(referenceSegments("@review then mail me@b.com, read @b/x, ask @someone, and @rv", (key) => known.has(key))).toEqual([
    { text: "@review", reference: true },
    { text: " then mail me@b.com, read @b/x, ask @someone, and ", reference: false },
    { text: "@rv", reference: true },
  ])
  expect(referenceSegments("", () => true)).toEqual([])
})

test("a shared snippet carries its name and fields; other clipboard text becomes a new snippet's text", () => {
  const fields = { description: "Review the diff", aliases: ["rv"], body: "Review it.\n\n---\nThen @style." }
  expect(parseShared(formatShared("review", fields))).toEqual({ name: "review", ...fields })
  expect(parseShared(formatShared("plain", { aliases: [], body: "Just text" }))).toEqual({ name: "plain", aliases: [], body: "Just text" })
  expect(parseShared("  Some prompt a coworker wrote\n")).toEqual({ aliases: [], body: "Some prompt a coworker wrote" })
  expect(parseShared("---\nname: Not Valid\n---\nbody")).toEqual({ aliases: [], body: "body" })
})
