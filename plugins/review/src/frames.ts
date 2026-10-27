/** Views opened from the diff: which one a place opens in, and the trail back. Knows nothing about the host. */

import type { Frame } from "./host"
import type { Place } from "./references"

/** A place opens on its diff row when the diff shows its line, else in a read-only view of its file around it. */
export function frameFor(place: Place, shown: (file: string) => ReadonlySet<number> | undefined, id: number): Frame {
  return shown(place.file)?.has(place.line)
    ? { id, kind: "diff", file: place.file, line: place.line, old: false }
    : { id, kind: "file", file: place.file, line: place.line, center: place.line }
}

/** Where the open views lead from the diff, as a breadcrumb. */
export function trail(stack: readonly Frame[]): string {
  return ["diff", ...stack.map((frame) => frame.kind === "refs" ? `${frame.query === "usages" ? "usages" : "definition"} of ${frame.lookup.name}`
    : frame.kind === "search" ? `search "${frame.query}"` : `${frame.file}:${frame.line ?? ""}`)].join(" › ")
}

let last = 0
/** A frame ID unique within this terminal, also across panel reopenings. */
export function frameID(now = Date.now()): number {
  last = Math.max(last + 1, now)
  return last
}
