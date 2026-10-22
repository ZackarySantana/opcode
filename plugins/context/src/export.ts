import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { stateDirectory } from "@opcode/core/state"
import type { Snapshot } from "./snapshot"

export function redact(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_|github_pat_|glpat-|npm_|(?:sk|pk)[-_]|xox[baprs]-)[a-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[a-z0-9._~+\/-]+=*/gi, "[REDACTED]")
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi, "[REDACTED]")
}

/** Snapshot values contain metadata/counts only. Sanitize every string, not just selected display fields. */
export function exportPayload(snapshot: Snapshot): Snapshot {
  return JSON.parse(JSON.stringify(snapshot, (_key, value: unknown) => typeof value === "string" ? redact(value) : value)) as Snapshot
}

export function exportDirectory(env: NodeJS.ProcessEnv = process.env) {
  return join(stateDirectory(env), "opcode-context", "exports")
}

export async function writeSnapshot(snapshot: Snapshot, directory = exportDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stamp = snapshot.capturedAt.replace(/[^0-9TZ-]/g, "-")
  const path = join(directory, `context-${stamp}-${randomUUID()}.json`)
  await writeFile(path, `${JSON.stringify(exportPayload(snapshot), null, 2)}\n`, { mode: 0o600, flag: "wx" })
  return path
}
