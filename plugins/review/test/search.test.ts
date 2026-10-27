import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseGitGrep, parseRipgrep, searchName, type Output, type Runner } from "../src/search"

const signal = () => new AbortController().signal

const rgMatch = (path: string, line: number, text: string, starts: number[]) =>
  JSON.stringify({ type: "match", data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: line, absolute_offset: 0, submatches: starts.map((start) => ({ match: { text: "x" }, start, end: start + 1 })) } })

test("ripgrep matches become one place per match, with byte columns turned into UTF-16 columns", () => {
  const stdout = [
    JSON.stringify({ type: "begin", data: { path: { text: "src/b.ts" } } }),
    rgMatch("src/b.ts", 3, "const é = foo(foo)", [11, 15]),
    rgMatch("./a.ts", 1, "// 😀 foo", [8]),
    JSON.stringify({ type: "match", data: { path: { bytes: "/w==" }, lines: { text: "foo\n" }, line_number: 1, submatches: [{ start: 0 }] } }),
    JSON.stringify({ type: "summary", data: {} }),
    "",
  ].join("\n")
  expect(parseRipgrep(stdout, 10)).toEqual({
    places: [
      { file: "a.ts", line: 1, column: 6, text: "// 😀 foo" },
      { file: "src/b.ts", line: 3, column: 10, text: "const é = foo(foo)" },
      { file: "src/b.ts", line: 3, column: 14, text: "const é = foo(foo)" },
    ],
    truncated: false,
  })
  expect(parseRipgrep(stdout, 2)).toMatchObject({ places: [{ file: "a.ts" }, { file: "src/b.ts", column: 10 }], truncated: true })
})

test("git grep lines become places, with paths kept whole and 1-based byte columns turned into 0-based UTF-16 columns", () => {
  const stdout = "src/a.ts\x0012\x005\x00let foo = 1\r\nnaïve:1:2:dir/b.ts\x002\x0012\x00const é = foo: string\nline\nbreak.ts\x001\x001\x00foo"
  expect(parseGitGrep(stdout, 10)).toEqual({
    places: [
      { file: "line\nbreak.ts", line: 1, column: 0, text: "foo" },
      { file: "naïve:1:2:dir/b.ts", line: 2, column: 10, text: "const é = foo: string" },
      { file: "src/a.ts", line: 12, column: 4, text: "let foo = 1" },
    ],
    truncated: false,
  })
})

test("search prefers ripgrep, drops a line cut off at the output limit, and reports failures", async () => {
  const calls: (readonly string[])[] = []
  const output = (result: Partial<Output>): Runner => async (argv) => { calls.push(argv); return { stdout: "", stderr: "", status: 0, clipped: false, ...result } }
  const which = (command: string) => `/bin/${command}`
  const stdout = `${rgMatch("a.ts", 1, "foo", [0])}\n${rgMatch("b.ts", 1, "foo", [0]).slice(0, 30)}`
  expect(await searchName("/w", "foo", signal(), { which, run: output({ stdout, clipped: true }) })).toEqual({ places: [{ file: "a.ts", line: 1, column: 0, text: "foo" }], truncated: true })
  // No cap per file, which would drop matches without reporting them.
  expect(calls[0]).toEqual(["/bin/rg", "--json", "-w", "-F", "--", "foo"])
  // No matches is an answer, not a failure.
  expect(await searchName("/w", "-foo", signal(), { which, run: output({ status: 1 }) })).toEqual({ places: [], truncated: false })
  await expect(searchName("/w", "foo", signal(), { which, run: output({ status: 2, stderr: "rg: bad things" }) })).rejects.toThrow("rg: bad things")
  await expect(searchName("/w", "foo", signal(), { which: () => null })).rejects.toThrow("ripgrep (rg) or git")
  const slow: Runner = (_argv, _cwd, signal) => new Promise((_, fail) => signal.addEventListener("abort", () => fail(signal.reason)))
  await expect(searchName("/w", "foo", signal(), { which, run: slow, timeout: 20 })).rejects.toThrow("the search timed out")
})

const root = mkdtempSync(join(tmpdir(), "review-search-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const git = async (cwd: string, ...args: string[]) => { await Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exited }
const withoutRipgrep = (command: string) => command === "rg" ? null : Bun.which(command)

test("git grep finds whole words in tracked and untracked files, leaving out ignored ones and other directories' files", async () => {
  const repo = join(root, "repo")
  mkdirSync(join(repo, "src"), { recursive: true })
  writeFileSync(join(repo, ".gitignore"), "build/\n")
  writeFileSync(join(repo, "src", "a.ts"), "export const foo = 1\nconst foobar = foo\n")
  writeFileSync(join(repo, "src", "odd:1:2:name.ts"), "foo\n")
  writeFileSync(join(repo, "notes.md"), "Use foo, not foo_bar.\n")
  mkdirSync(join(repo, "build"))
  writeFileSync(join(repo, "build", "out.js"), "foo\n")
  await git(repo, "init", "-q")
  await git(repo, "add", "src")
  expect(await searchName(repo, "foo", signal(), { which: withoutRipgrep })).toEqual({
    places: [
      { file: "notes.md", line: 1, column: 4, text: "Use foo, not foo_bar." },
      { file: "src/a.ts", line: 1, column: 13, text: "export const foo = 1" },
      { file: "src/a.ts", line: 2, column: 15, text: "const foobar = foo" },
      { file: "src/odd:1:2:name.ts", line: 1, column: 0, text: "foo" },
    ],
    truncated: false,
  })
})

test("outside a repository, git grep searches the directory's files", async () => {
  const plain = join(root, "plain")
  mkdirSync(plain)
  writeFileSync(join(plain, "a.py"), "def foo():\n  pass\n")
  // A ceiling keeps git from finding a repository above the temp directory.
  const env = { GIT_CEILING_DIRECTORIES: root }
  expect((await searchName(plain, "foo", signal(), { which: withoutRipgrep, env })).places).toEqual([{ file: "a.py", line: 1, column: 4, text: "def foo():" }])
})
