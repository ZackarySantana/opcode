import { age } from "@opcode/tabs/format"
import type { Item, Mark } from "@opcode/tabs"
import type { usePalette } from "@opcode/ui"
import { reviewers, type Entry, type Tone } from "./model"

type Palette = ReturnType<typeof usePalette>

export function toneMark(tone: Tone, palette: Palette): Mark {
  switch (tone) {
    case "urgent": return { glyph: "●", color: palette.error, title: palette.text, strong: true }
    case "attention": return { glyph: "●", color: palette.warning, title: palette.text, strong: true }
    case "ready": return { glyph: "✓", color: palette.success, title: palette.text, strong: false }
    case "waiting": return { glyph: "○", color: palette.value, title: palette.text, strong: false }
    case "quiet": return { glyph: "·", color: palette.muted, title: palette.muted, strong: false }
  }
}

/** A dialog card: status, author and where, when it opened and when your review was requested, then who is requested. */
export function card(entry: Entry, viewer: string, now: number, palette: Palette): Item {
  const { pr } = entry
  const requested = reviewers(pr)
  const where = `${pr.repository}#${pr.number}`
  return {
    key: pr.url, mark: toneMark(entry.tone, palette), head: entry.label, detail: pr.author === viewer ? where : `@${pr.author} · ${where}`,
    time: [`opened ${age(pr.createdAt, now)} ago`, ...entry.requestedAt ? [`requested ${age(entry.requestedAt, now)} ago`] : []].join(" · "),
    title: pr.title, lines: requested ? [`Requested: ${requested}`] : undefined,
  }
}

/** A sidebar entry: author, or for your own pull requests, which one. */
export function sidebarItem(entry: Entry, viewer: string, now: number, palette: Palette): Item {
  const { pr } = entry
  return {
    key: pr.url, mark: toneMark(entry.tone, palette), head: entry.label,
    detail: pr.author === viewer ? `${pr.repository.split("/").pop()}#${pr.number}` : `@${pr.author}`,
    time: age(entry.requestedAt ?? pr.createdAt, now), title: pr.title,
  }
}
