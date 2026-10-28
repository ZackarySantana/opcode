import { errorMessage } from "@opcode/core"
import type { ComposerPillView } from "@opencode/plugin/gui"
import { sameItem, type LaterItem } from "../domain"

/** One line for a menu row: the item's first non-empty line, shortened at a word where it can be. */
export function rowLabel(message: string, max = 72): string {
  const line = message.split("\n").map((part) => part.trim()).find(Boolean) ?? ""
  const more = message.trim() !== line
  if (line.length <= max) return more ? `${line} …` : line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The muted count beside the Later launcher, omitted while the list is empty or not read yet. */
export function launcherDescription(active: readonly LaterItem[]): string | undefined {
  return active.length ? String(active.length) : undefined
}

/** The pill above the composer: one row per active item, in order; none while the list is empty. */
export function pillView(
  active: readonly LaterItem[],
  text: { label: string; title: string },
  use: (item: LaterItem) => void,
): ComposerPillView | undefined {
  if (!active.length) return undefined
  return {
    label: text.label,
    icon: "checklist",
    title: text.title,
    rows: active.map((item, index) => ({ id: item.id, label: rowLabel(item.message), detail: `${index + 1}`, run: () => use(item) })),
  }
}

export type UseOutcome =
  | { type: "used" }
  /** Inserted, but the item changed before it could be completed. */
  | { type: "kept" }
  /** Nothing inserted: the item changed since the user saw it. */
  | { type: "changed" }
  /** Nothing inserted: there is no prompt to insert into. */
  | { type: "unavailable" }
  /** Inserted, but completing it failed. */
  | { type: "failed"; message: string }

/**
 * The desktop's paste: types the item into the prompt for the user to review, never sending it, then completes it.
 * `latest` is the item in the newest list; an item that changed since the user saw it is not inserted. `complete` is
 * false when the server refused because the item changed meanwhile.
 */
export async function useItem(
  item: LaterItem,
  latest: LaterItem | undefined,
  composer: { insert(text: string): void; focus(): void } | undefined,
  complete: (item: LaterItem) => Promise<boolean>,
): Promise<UseOutcome> {
  if (!composer) return { type: "unavailable" }
  if (item.completedAt !== undefined || !sameItem(latest, item)) return { type: "changed" }
  composer.insert(item.message)
  composer.focus()
  try {
    return { type: await complete(item) ? "used" : "kept" }
  } catch (error) {
    return { type: "failed", message: errorMessage(error) }
  }
}

/** How each outcome reads in a toast, as i18n keys. */
export function useToast(outcome: UseOutcome): { title: string; variant: "success" | "error" | "default"; description?: string } {
  switch (outcome.type) {
    case "used": return { title: "toast.used", variant: "success" }
    case "kept": return { title: "toast.kept", variant: "default" }
    case "changed": return { title: "toast.changed", variant: "default" }
    case "unavailable": return { title: "toast.unavailable", variant: "default" }
    case "failed": return { title: "toast.failed", variant: "error", description: outcome.message }
  }
}
