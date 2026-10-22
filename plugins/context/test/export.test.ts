import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import type { SessionMessageInfo } from "@opencode/client"
import { exportDirectory, exportPayload, redact, writeSnapshot } from "../src/export"
import { buildSnapshot } from "../src/snapshot"
import { user } from "./helpers"

test("redacts common tokens, quoted credentials, bearer tokens, and URL secrets", () => {
  for (const value of ["ghp_abcdefghijklmnopqrst", "github_pat_abcdefghijklmnopqrst", "sk-proj-abcdefghijklmnop", "xoxb-abcdefghijklmnop",
    "Bearer abcdefghijklmnop", "Authorization: Basic abcdefghijklmnop", '{"password":"private value"}',
    '{"password":"private \\"value"}', "api_key=private", "https://user:private@example.com/?token=private"]) {
    expect(redact(value)).not.toContain("private")
    expect(redact(value)).not.toContain("abcdefghijklmnop")
  }
  expect(redact("Read project files in AGENTS.md")).toBe("Read project files in AGENTS.md")
  expect(redact("API documentation: api_key=private, files: README.md")).toBe("API documentation: [REDACTED], files: README.md")
  expect(redact('before {"password":"private \\"value"} after')).toBe('before {"[REDACTED]} after')
  expect(redact("https://user:private@example.com/?token=private&view=summary")).toBe("https://[REDACTED]@example.com/?[REDACTED]&view=summary")
})

test("redacts prefixed environment secrets, non-HTTP URL credentials, and provider key formats", () => {
  for (const value of ["OPENAI_API_KEY=private", "AWS_SECRET_ACCESS_KEY=private", "GITHUB_TOKEN=private", "client_secret=private",
    "export DB_PASSWORD='private value'", "postgres://user:private@db.internal:5432/app", "mongodb+srv://user:private@cluster.example.net/db",
    "redis://:private@cache:6379", "gsk_privateprivateprivate", "hf_privateprivateprivate", "AIzaSyprivateprivateprivateprivateprivate0",
    "https://maps.example.com/api?key=private&q=x", "https://example.com/file?q=x&key=private"]) {
    expect(redact(value)).not.toContain("private")
  }
  expect(redact("Authorization: Bearer abc.def")).toBe("[REDACTED]")
  expect(redact('{"Authorization":"Bearer abc.def"} ok')).toBe('{"[REDACTED]} ok')
  expect(redact("OPENAI_API_KEY=abc123 next")).toBe("[REDACTED] next")
  expect(redact("postgres://user:pass@db/app")).toBe("postgres://[REDACTED]@db/app")
  expect(redact("https://example.com/file?q=x&key=abc#top")).toBe("https://example.com/file?q=x&[REDACTED]#top")
  for (const benign of ["max_tokens: 4096 output", "Token budget and password policy docs", "keyboard shortcuts", "monkey=banana",
    "git@github.com:owner/repo.git", "file:///home/user/notes.md", "Basic", "AIza", "hf_hub", "mcp: docs connected"]) {
    expect(redact(benign)).toBe(benign)
  }
})

test("export is metadata only and sanitizes all string fields", () => {
  const messages: SessionMessageInfo[] = [
    { id: "ghp_abcdefghijklmnopqrst", type: "user", text: "BODY_USER_ONLY", time: { created: 1 }, files: [
      { data: "BODY_ATTACHMENT_ONLY", mime: "text/plain", name: "note.txt", source: { type: "uri", uri: "file:///note.txt" } },
    ] },
    { id: "assistant", type: "assistant", agent: "build", model: { providerID: "p", id: "m" }, time: { created: 2 }, content: [
      { type: "text", text: "BODY_ASSISTANT_ONLY" }, { type: "reasoning", text: "BODY_REASONING_ONLY" },
      { type: "tool", id: "tool", name: "read", time: { created: 2 }, state: { status: "completed", input: { value: "BODY_TOOL_INPUT_ONLY" }, content: [{ type: "text", text: "BODY_TOOL_OUTPUT_ONLY" }] } },
      { type: "tool", id: "error", name: "shell", time: { created: 2 }, state: { status: "error", input: {}, error: { type: "failure", message: "BODY_ERROR_ONLY" } } },
    ] },
    { id: "compact", type: "compaction", status: "completed", reason: "manual", summary: "BODY_SUMMARY_ONLY", time: { created: 3 } },
    { id: "system", type: "system", text: "BODY_SYSTEM_ONLY", time: { created: 1 } },
    { id: "synthetic", type: "synthetic", text: "BODY_SYNTHETIC_ONLY", time: { created: 1 } },
    { id: "skill", type: "skill", skill: "testing", name: "Testing", text: "BODY_SKILL_ONLY", time: { created: 1 } },
    { id: "shell", type: "shell", shellID: "sh", command: "BODY_SHELL_COMMAND_ONLY", status: "exited", time: { created: 1 }, output: { output: "BODY_SHELL_OUTPUT_ONLY", cursor: 0, size: 22, truncated: false } },
  ]
  const snapshot = buildSnapshot({ sessionID: "s", messages, retainedMessages: messages,
    environment: [{ category: "instruction", name: "password=private" }, { category: "tool", name: "read", detail: "Read project files" }], warnings: ['{"secret":"private"}'] })
  const payload = exportPayload(snapshot)
  const text = JSON.stringify(payload)
  expect(text).not.toContain("BODY_")
  expect(text).not.toContain("private")
  expect(text).not.toContain("ghp_")
  expect(payload.retained?.estimatedTokens).toBeGreaterThan(0)
  expect(payload.retained?.contributors.find((item) => item.category === "file")?.label).toBe("Attachment: note.txt")
  expect(payload.environment).toContainEqual({ category: "tool", name: "read", detail: "Read project files" })
  expect(payload.sessionID).toBe("s")
  expect(snapshot.environment[0]?.name).toBe("password=private")
})

test("exports are local, private, unique, and cannot escape via a session identifier", async () => {
  expect(exportDirectory({ XDG_STATE_HOME: "/state" })).toBe("/state/opencode/opcode-context/exports")
  expect(exportDirectory({})).toBe(join(homedir(), ".local/state/opencode/opcode-context/exports"))
  const root = await mkdtemp(join(tmpdir(), "opcode-context-"))
  try {
    const directory = join(root, "exports")
    const snapshot = buildSnapshot({ sessionID: "../../escape", messages: [user("u", "PRIVATE")] })
    const a = await writeSnapshot(snapshot, directory), b = await writeSnapshot(snapshot, directory)
    expect(a).not.toBe(b)
    expect(a.startsWith(`${directory}/context-`)).toBe(true)
    expect((await stat(a)).mode & 0o777).toBe(0o600)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect(await readFile(a, "utf8")).not.toContain("PRIVATE")
  } finally { await rm(root, { recursive: true, force: true }) }
})
