import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { stateDirectory } from "@opcode/core/state"
import type { Snapshot } from "./snapshot"

/** Ordered so whole assignments (including `Authorization: Bearer …`) are replaced before their parts; placeholders never match later rules. */
export function redact(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(?<![a-z0-9])(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|token|password|passwd|secret|credentials?|authorization)["']?\s*[:=]\s*(?:(?:Bearer|Basic|Token)\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi, "[REDACTED]")
    .replace(/([?&])(?:key|sig|signature|x-amz-signature|x-amz-credential)=[^\s&#]+/gi, "$1[REDACTED]")
    .replace(/(?<![a-z0-9])(?:gh[pousr]_|github_pat_|glpat-|npm_|(?:sk|pk|rk)[-_]|xox[baprs]-|gsk_|hf_)[a-z0-9_-]{8,}/gi, "[REDACTED]")
    .replace(/(?<![a-z0-9])AIza[a-z0-9_-]{30,}/gi, "[REDACTED]")
    .replace(/(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, "[REDACTED]")
    .replace(/(?<![a-z0-9])eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/gi, "[REDACTED]")
    .replace(/(?<![a-z0-9])(?:Bearer|Basic)\s+[a-z0-9._~+\/-]+=*/gi, "[REDACTED]")
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
