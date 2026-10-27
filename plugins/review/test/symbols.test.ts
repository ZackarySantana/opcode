import { expect, test } from "bun:test"
import { parsePatch } from "../src/patch"
import { defaultToken, identifiers, isDefinition, wordMarks } from "../src/symbols"

const names = (text: string, file: string) => identifiers(text, file).map((token) => token.name)

test("identifiers skip strings, comments, and keywords, and report where each name sits", () => {
  expect(identifiers(`const total = sum(items, "skip me") // and me`, "a.ts")).toEqual([
    { name: "total", start: 6, end: 11 }, { name: "sum", start: 14, end: 17 }, { name: "items", start: 18, end: 23 },
  ])
  expect(names("const label = `count ${n}` + $el.text", "a.tsx")).toEqual(["label", "$el", "text"])
  expect(names(`if user.name == 'x': return fmt(user)  # comment`, "a.py")).toEqual(["user", "name", "fmt", "user"])
  expect(names(`func (s *Server) Run(ctx context.Context) error { return "x" } // done`, "a.go")).toEqual(["s", "Server", "Run", "ctx", "context", "Context"])
})

test("a hash is code where it isn't a comment, and a quote can be a character or a lifetime", () => {
  expect(names("#include <vector> // std", "a.cpp")).toEqual(["vector"])
  expect(names("this.#count = 1 // private", "a.js")).toEqual(["count"])
  expect(names("fn first<'a>(s: &'a str) -> char { 'x' }", "a.rs")).toEqual(["first", "s"])
  expect(names("x = 0x1f + größe.länge", "a.py")).toEqual(["x", "größe", "länge"])
})

test("the default token is the name an added line defines", () => {
  const rows = parsePatch("@@ -1,0 +1,1 @@\n+export function render(props) {\n")
  expect(identifiers(rows[0]!.text, "a.ts")[defaultToken(rows[0]!, rows, "a.ts")]!.name).toBe("render")
})

test("on a changed line the default token is the name the change introduced", () => {
  const rows = parsePatch("@@ -1,1 +1,1 @@\n-  save(user, cache)\n+  save(user, store)\n")
  const add = rows[1]!
  expect(identifiers(add.text, "a.ts")[defaultToken(add, rows, "a.ts")]!.name).toBe("store")
  // The removed side points at what went away.
  expect(identifiers(rows[0]!.text, "a.ts")[defaultToken(rows[0]!, rows, "a.ts")]!.name).toBe("cache")
})

test("otherwise the default token is the first call, then the first identifier", () => {
  const rows = parsePatch("@@ -1,2 +1,2 @@\n result.value = compute<T>(input)\n total\n")
  expect(identifiers(rows[0]!.text, "a.ts")[defaultToken(rows[0]!, rows, "a.ts")]!.name).toBe("compute")
  expect(defaultToken(rows[1]!, rows, "a.ts")).toBe(0)
  expect(defaultToken({ ...rows[1]!, text: "return" }, rows, "a.ts")).toBe(0)
})

test("TypeScript definitions are declarations, methods, and fields, never calls", () => {
  const ts = (text: string, name: string) => isDefinition(text, name, "a.ts")
  expect(ts("export default function render(props) {", "render")).toBe(true)
  expect(ts("export const handler = async (event) => {", "handler")).toBe(true)
  expect(ts("const { user, token } = session", "token")).toBe(true)
  expect(ts("export type Options = { depth: number }", "Options")).toBe(true)
  expect(ts("export interface Options {", "Options")).toBe(true)
  expect(ts("  async load(id: string): Promise<User> {", "load")).toBe(true)
  expect(ts("  private readonly cache = new Map()", "cache")).toBe(true)
  expect(ts("  render(props) {", "render")).toBe(true)

  expect(ts("render(props)", "render")).toBe(false)
  expect(ts("  render(() => {", "render")).toBe(false)
  expect(ts("const html = render(props)", "render")).toBe(false)
  expect(ts("import type Options from './options'", "Options")).toBe(false)
  expect(ts("// function render() {", "render")).toBe(false)
  expect(ts("const rendered = 1", "render")).toBe(false)
  expect(ts("if (a === b) return", "a")).toBe(false)
})

test("definitions in Python, Go, and Rust", () => {
  expect(isDefinition("    def save(self, user):", "save", "a.py")).toBe(true)
  expect(isDefinition("TIMEOUT = 30", "TIMEOUT", "a.py")).toBe(true)
  expect(isDefinition("        self.cache = {}", "cache", "a.py")).toBe(true)
  expect(isDefinition("if save(user) == 1:", "save", "a.py")).toBe(false)
  expect(isDefinition("save(user)", "save", "a.py")).toBe(false)

  expect(isDefinition("func (s *Server) Run(ctx context.Context) error {", "Run", "a.go")).toBe(true)
  expect(isDefinition("\tconn, err := dial(addr)", "err", "a.go")).toBe(true)
  expect(isDefinition("\tName string `json:\"name\"`", "Name", "a.go")).toBe(true)
  expect(isDefinition("\tif err := dial(addr); err != nil {", "dial", "a.go")).toBe(false)
  expect(isDefinition("\tRun(ctx)", "Run", "a.go")).toBe(false)

  expect(isDefinition("pub fn parse(input: &str) -> Result<Ast> {", "parse", "a.rs")).toBe(true)
  expect(isDefinition("    let mut count = 0;", "count", "a.rs")).toBe(true)
  expect(isDefinition("pub struct Config {", "Config", "a.rs")).toBe(true)
  expect(isDefinition("    let ast = parse(input)?;", "parse", "a.rs")).toBe(false)
})

test("definitions in Java, Kotlin, C, and Ruby, where a type can lead", () => {
  expect(isDefinition("  public static List<User> findAll(int limit) {", "findAll", "A.java")).toBe(true)
  expect(isDefinition("  public Repo(DataSource source) {", "Repo", "A.java")).toBe(true)
  expect(isDefinition("    User user = new User(name);", "user", "A.java")).toBe(true)
  expect(isDefinition("    User user = new User(name);", "User", "A.java")).toBe(false)
  expect(isDefinition("    return findAll(10);", "findAll", "A.java")).toBe(false)
  expect(isDefinition("fun String.slug(): String = lowercase()", "slug", "a.kt")).toBe(true)

  expect(isDefinition("static int *parse_header(const char *line) {", "parse_header", "a.c")).toBe(true)
  expect(isDefinition("#define MAX_LEN 64", "MAX_LEN", "a.h")).toBe(true)
  expect(isDefinition("  total = count * parse_header(line);", "parse_header", "a.c")).toBe(false)
  expect(isDefinition("  else parse_header(line);", "parse_header", "a.c")).toBe(false)

  expect(isDefinition("  def self.build(attrs)", "build", "a.rb")).toBe(true)
  expect(isDefinition("  attr_reader :name, :email", "email", "a.rb")).toBe(true)
  expect(isDefinition("  build(attrs) # def build", "build", "a.rb")).toBe(false)
})

test("a name is marked wherever it is an identifier in the block, with the picked one apart, but not inside strings or comments", () => {
  const lines = ["const ttl = load(ttl)", "log(\"ttl is set\") // ttl", "return ttlx + ttl"]
  const marks = wordMarks(lines, "a.ts", "ttl", { line: 0, start: 17 })
  const text = lines.join("\n")
  expect(marks.map((mark) => [text.slice(mark.start, mark.end), mark.style, mark.start])).toEqual([
    ["ttl", "word", 6], ["ttl", "token", 17], ["ttl", "word", lines[0]!.length + 1 + lines[1]!.length + 1 + 14],
  ])
  expect(wordMarks(lines, "a.ts", undefined)).toEqual([])
})
