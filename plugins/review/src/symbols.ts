/** Names on a line of code, which one a reviewer most likely means, and which lines define them. Knows nothing about the host. */

import type { Row } from "./patch"

/** An identifier on a line: its name and where it sits, as 0-based UTF-16 offsets into the line. */
export interface Token {
  readonly name: string
  readonly start: number
  readonly end: number
}

type Language = "js" | "python" | "go" | "rust" | "java" | "kotlin" | "c" | "ruby" | "generic"

const EXTENSIONS: Record<string, Language> = {
  ts: "js", tsx: "js", mts: "js", cts: "js", js: "js", jsx: "js", mjs: "js", cjs: "js",
  py: "python", pyi: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hh: "c", hpp: "c", hxx: "c", rb: "ruby",
}

const languageOf = (file: string): Language => EXTENSIONS[/\.([^./]+)$/.exec(file)?.[1]?.toLowerCase() ?? ""] ?? "generic"

interface Syntax {
  /** Characters that open and close a string. */
  readonly quotes: string
  /** Whether `'` opens a one-character literal rather than a string, so lifetimes and digit separators stay code. */
  readonly chars: boolean
  readonly comment: "slash" | "hash" | "both"
  /** Whether `/* ... *\/` comments exist. */
  readonly block: boolean
  /** Whether `$` can be part of a name. */
  readonly dollar: boolean
  readonly keywords: ReadonlySet<string>
}

const words = (text: string) => new Set(text.split(/\s+/).filter(Boolean))

const CLIKE = "break case const continue default do else enum for goto if return sizeof static struct switch typedef union void volatile while"
const SYNTAX: Record<Language, Syntax> = {
  js: {
    quotes: "'\"`", chars: false, comment: "slash", block: true, dollar: true,
    keywords: words(`break case catch class const continue debugger default delete do else enum export extends false finally for function if import in
      instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private
      protected public await async of from as type namespace declare abstract readonly keyof infer is satisfies override undefined any unknown never
      number string boolean symbol bigint`),
  },
  python: {
    quotes: "'\"", chars: false, comment: "hash", block: false, dollar: false,
    keywords: words(`False None True and as assert async await break class continue def del elif else except finally for from global if import in is
      lambda nonlocal not or pass raise return try while with yield self`),
  },
  go: {
    quotes: "\"`", chars: true, comment: "slash", block: true, dollar: false,
    keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import interface map package range return
      select struct switch type var true false nil iota any bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune
      string uint uint8 uint16 uint32 uint64 uintptr`),
  },
  rust: {
    quotes: "\"", chars: true, comment: "slash", block: true, dollar: false,
    keywords: words(`as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref
      return self Self static struct super trait true type unsafe use where while i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool
      char str`),
  },
  java: {
    quotes: "\"", chars: true, comment: "slash", block: true, dollar: true,
    keywords: words(`abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally
      float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp
      super switch synchronized this throw throws transient try void volatile while true false null var record sealed permits yield`),
  },
  kotlin: {
    quotes: "\"", chars: true, comment: "slash", block: true, dollar: false,
    keywords: words(`as break class continue do else false for fun if in interface is null object package return super this throw true try
      typealias val var when while by catch constructor finally get import init set where abstract annotation companion const crossinline data
      enum external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed
      suspend tailrec vararg`),
  },
  c: {
    quotes: "\"", chars: true, comment: "slash", block: true, dollar: false,
    keywords: words(`${CLIKE} auto char double extern float inline int long register restrict short signed unsigned bool true false NULL nullptr
      alignas alignof asm catch class constexpr const_cast decltype delete dynamic_cast explicit export friend mutable namespace new noexcept
      operator private protected public reinterpret_cast static_assert static_cast template this thread_local throw try typeid typename using
      virtual wchar_t override final co_await co_return co_yield concept requires include define undef ifdef ifndef elif endif pragma`),
  },
  ruby: {
    quotes: "'\"", chars: false, comment: "hash", block: false, dollar: false,
    keywords: words(`BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo
      rescue retry return self super then true undef unless until when while yield`),
  },
  generic: {
    quotes: "'\"", chars: false, comment: "both", block: false, dollar: false,
    keywords: words("if else elif for while do return function func fn def class struct const let var true false null nil and or not in is then end"),
  },
}

const CHAR = /'(?:\\[^']+|[^\\'])'/uy
const NUMBER = /\p{N}[\p{L}\p{N}_]*(?:\.\p{N}[\p{L}\p{N}_]*)*/uy

/** The line with its strings and comments blanked to spaces, so offsets still line up with the original. */
function code(text: string, syntax: Syntax): string {
  let result = ""
  let index = 0
  const blank = (to: number) => { result += " ".repeat(to - index); index = to }
  while (index < text.length) {
    const char = text[index]!
    const next = text[index + 1]
    const spaced = index === 0 || /\s/.test(text[index - 1]!)
    const slash = syntax.comment !== "hash" && char === "/" && next === "/"
    // In the fallback, `#` starts a comment only as its own word, so `a#b` and `#{` stay code.
    const hash = char === "#" && (syntax.comment === "hash" || syntax.comment === "both" && spaced)
    if (slash || hash) { blank(text.length); break }
    if (syntax.block && char === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2)
      blank(close < 0 ? text.length : close + 2)
      continue
    }
    if (syntax.chars && char === "'") {
      CHAR.lastIndex = index
      if (CHAR.test(text)) blank(CHAR.lastIndex)
      else { result += char; index++ }
      continue
    }
    if (syntax.quotes.includes(char)) {
      let end = index + 1
      while (end < text.length && text[end] !== char) end += text[end] === "\\" ? 2 : 1
      blank(Math.min(end + 1, text.length))
      continue
    }
    result += char
    index++
  }
  return result
}

/** Every name on the masked line, keywords included. */
function scan(masked: string, syntax: Syntax): Token[] {
  const name = syntax.dollar ? /[\p{L}_$][\p{L}\p{M}\p{N}_$]*/uy : /[\p{L}_][\p{L}\p{M}\p{N}_]*/uy
  const tokens: Token[] = []
  let index = 0
  while (index < masked.length) {
    name.lastIndex = index
    const match = name.exec(masked)
    if (match) {
      // A Rust lifetime or label such as 'a names no symbol.
      if (!(syntax.chars && masked[index - 1] === "'")) tokens.push({ name: match[0], start: index, end: name.lastIndex })
      index = name.lastIndex
      continue
    }
    NUMBER.lastIndex = index
    index = NUMBER.test(masked) ? NUMBER.lastIndex : index + 1
  }
  return tokens
}

/** The identifiers on a line, in order, without the language's keywords, strings, or comments. */
export function identifiers(text: string, file: string): Token[] {
  const syntax = SYNTAX[languageOf(file)]
  return scan(code(text, syntax), syntax).filter((token) => !syntax.keywords.has(token.name))
}

/** Which token on the row to start on: a name defined there, then a changed token, a call, or the first identifier. */
export function defaultToken(row: Row, rows: readonly Row[], file: string): number {
  const tokens = identifiers(row.text, file)
  if (!tokens.length) return 0
  const found = (index: number) => index < 0 ? undefined : index
  if (row.kind === "add") {
    const defined = found(tokens.findIndex((token) => isDefinition(row.text, token.name, file)))
    if (defined !== undefined) return defined
  }
  const paired = pairedRows(row, rows)
  if (paired.length) {
    const before = new Set(paired.flatMap((other) => identifiers(other.text, file).map((token) => token.name)))
    const changed = found(tokens.findIndex((token) => !before.has(token.name)))
    if (changed !== undefined) return changed
  }
  return found(tokens.findIndex((token) => isCall(row.text, token))) ?? 0
}

/** Whether the token is called on the line: followed by `(`, perhaps after generic arguments. */
export const isCall = (text: string, token: Token) => /^\s*(?:<[^<>()]*>\s*)?(?:::\s*<[^<>()]*>\s*)?\(/.test(text.slice(token.end))

/** The rows a changed row replaced or was replaced by: the removed run before an added run, or the added run after a removed one. */
function pairedRows(row: Row, rows: readonly Row[]): Row[] {
  if (row.kind === "ctx") return []
  const index = rows.indexOf(row)
  if (index < 0) return []
  const same = (other: Row | undefined, kind: Row["kind"]) => other?.hunk === row.hunk && other.kind === kind
  let at = index
  if (row.kind === "add") {
    while (same(rows[at - 1], "add")) at--
    const paired: Row[] = []
    while (same(rows[at - 1], "del")) paired.unshift(rows[--at]!)
    return paired
  }
  while (same(rows[at + 1], "del")) at++
  const paired: Row[] = []
  while (same(rows[at + 1], "add")) paired.push(rows[++at]!)
  return paired
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Words that can sit before `name(` or `name =` without being its type. */
const NOT_TYPES = words(`return new throw else case await yield typeof in of instanceof delete do goto sizeof assert not and or is as echo print puts
  co_await co_return co_yield using import package export extends implements throws when if while for switch catch`)

/** Patterns over the masked line, where %N stands for the name and %W for a name character. Each match is a definition. */
const JS = [
  String.raw`\b(?:function\s*\*?|class|interface|enum|namespace)\s+%N\b`,
  String.raw`\btype\s+%N\s*(?:<[^>]*>\s*)?=`,
  String.raw`\b(?:const|let|var)\s+%N\b`,
  // Destructuring defines every name it lists.
  String.raw`\b(?:const|let|var)\s+[{[][^=]*%N[^=]*[}\]]\s*=`,
  // Methods: `name(params) {`, or with a return type, never with a call inside the parentheses.
  String.raw`^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set|declare)\s+|\*\s*)*#?%N\s*(?:<[^>]*>\s*)?\([^()]*\)\s*(?:\{|:\s*[^=;{]+(?:[;{]|$))`,
  // Fields and object keys: `name: value`, `name = value`.
  String.raw`^\s*(?:(?:public|private|protected|static|readonly|override|abstract|declare)\s+)*#?%N\s*[?!]?\s*(?::(?!:)|=(?![=>]))`,
]
const PYTHON = [
  String.raw`\b(?:def|class)\s+%N\b`,
  String.raw`^\s*(?:self\.)?%N\s*(?::[^=]+)?=(?!=)`,
  String.raw`^\s*(?:%W+\s*,\s*)+%N\s*(?:,\s*%W+\s*)*=(?!=)`,
  String.raw`^\s*%N\s*(?:,\s*%W+\s*)+=(?!=)`,
  String.raw`^\s*%N\s*:\s*[\p{L}_][^=]*$`,
]
const GO = [
  String.raw`\bfunc\s+(?:\([^)]*\)\s*)?%N\b`,
  String.raw`\b(?:type|var|const)\s+%N\b`,
  String.raw`^\s*(?:%W+\s*,\s*)*%N\s*(?:,\s*%W+\s*)*:=`,
  // A struct field: the name, its type, maybe a tag, and nothing else.
  String.raw`^\s*%N\s+[*\[\]\p{L}\p{N}_.]+(?:\s+\S*)?\s*$`,
]
const RUST = [
  String.raw`\b(?:fn|struct|enum|trait|type|mod|union)\s+%N\b`,
  String.raw`\bmacro_rules!\s*%N\b`,
  String.raw`\b(?:let|const|static)\s+(?:mut\s+)?%N\b`,
  String.raw`^\s*(?:pub(?:\([^)]*\))?\s+)?%N\s*:(?!:)`,
]
const JVM = [
  String.raw`\b(?:class|interface|enum|record|object|typealias|val|var)\s+%N\b`,
  String.raw`\bfun\s+(?:<[^>]*>\s*)?(?:[\p{L}\p{N}_.<>?]+\.)?%N\b`,
]
const C = [
  String.raw`\b(?:struct|class|union|enum|typedef|namespace)\s+%N\b`,
  String.raw`#\s*define\s+%N\b`,
  String.raw`\btypedef\b.*%N\s*;`,
]
const RUBY = [
  String.raw`\bdef\s+(?:self\.)?%N`,
  String.raw`\b(?:class|module)\s+(?:%W+::)*%N\b`,
  String.raw`^\s*(?:@|@@|\$)?%N\s*=(?![=~])`,
  String.raw`\battr_(?:reader|writer|accessor)\b.*:%N\b`,
]
const GENERIC = [
  String.raw`\b(?:function|def|fn|func|fun|class|struct|interface|type|enum|trait|const|let|var|val|local)\s+%N\b`,
  String.raw`^\s*%N\s*:?=(?!=)`,
  String.raw`^\s*%N\s*\(\s*\)\s*\{`,
]
const PATTERNS: Record<Language, readonly string[]> = { js: JS, python: PYTHON, go: GO, rust: RUST, java: JVM, kotlin: JVM, c: C, ruby: RUBY, generic: GENERIC }

/** Whether the line defines `name` (a function, class, type, variable, method, or field), for the file's language. */
export function isDefinition(text: string, name: string, file: string): boolean {
  const language = languageOf(file)
  const syntax = SYNTAX[language]
  const masked = code(text, syntax)
  if (!scan(masked, syntax).some((token) => token.name === name)) return false
  const W = syntax.dollar ? "[\\p{L}\\p{M}\\p{N}_$]" : "[\\p{L}\\p{M}\\p{N}_]"
  // `\b` knows only ASCII, so the name's edges are checked against the language's own name characters.
  const N = `(?<!${W})${escape(name)}(?!${W})`
  const build = (pattern: string) => new RegExp(pattern.replace(/(?:\\b)?%N(?:\\b)?/g, N).replaceAll("%W", W), "u")
  if (PATTERNS[language].some((pattern) => build(pattern).test(masked))) return true
  return (language === "java" || language === "c") && typed(masked, N, W)
}

/** C-style `Type name(`, `Type name =`, or `Type name;`, where the word before isn't a statement word like `return`. */
function typed(masked: string, N: string, W: string): boolean {
  // `*` and `&` belong to the type or the name, so they touch one of them; `a * f(b)` is arithmetic.
  const pattern = new RegExp(`(?<!${W}|\\.)(${W}+)(?:<[^()=;]*>)?(?:\\[\\])*(?:[*&]+\\s+|\\s+[*&]+|\\s+)(?:${W}+::)*${N}\\s*(?:\\(|=(?!=)|;|\\[)`, "gu")
  return [...masked.matchAll(pattern)].some((match) => !NOT_TYPES.has(match[1]!) && !/^\p{N}/u.test(match[1]!))
}
