import { age, relative } from "@opcode/tabs/format"
import type { Item, Mark } from "@opcode/tabs"
import type { usePalette } from "@opcode/ui"
import type { Entry, Reviewer, Tone } from "./model"

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

/** Who is requested and when: you first, then your teams, other teams, and people. */
export function requestedLine(entry: Entry, viewer: string, now: number): string | undefined {
  const you = (reviewer: Reviewer) => reviewer.kind === "user" && reviewer.name.toLowerCase() === viewer.toLowerCase()
  const rank = (reviewer: Reviewer) => you(reviewer) ? 0 : reviewer.kind === "team" ? entry.teams.includes(reviewer.name) ? 1 : 2 : reviewer.kind === "user" ? 3 : 4
  const parts = [...entry.pr.requested].sort((a, b) => rank(a) - rank(b)).map((reviewer) => reviewer.kind === "hidden" ? "a hidden reviewer"
    : `${you(reviewer) ? "you" : reviewer.kind === "user" ? `@${reviewer.name}` : reviewer.name}${reviewer.requestedAt ? ` (${relative(reviewer.requestedAt, now)})` : ""}`)
  return parts.length ? `Requested: ${parts.join(", ")}` : undefined
}

/** A dialog card: status, author and where, when it came to you, then who is requested and when. */
export function card(entry: Entry, viewer: string, now: number, palette: Palette): Item {
  const { pr } = entry
  const where = `${pr.repository}#${pr.number}`
  return {
    key: pr.url, mark: toneMark(entry.tone, palette), head: entry.label, detail: entry.own ? where : `@${pr.author} · ${where}`,
    time: `${entry.since.event} ${relative(entry.since.at, now)}`, title: pr.title, summary: requestedLine(entry, viewer, now),
  }
}

/** A sidebar entry: author, or for your own pull requests, which one. The age is since it came to you, which lists sort by. */
export function sidebarItem(entry: Entry, now: number, palette: Palette): Item {
  const { pr } = entry
  return {
    key: pr.url, mark: toneMark(entry.tone, palette), head: entry.label, link: pr.url,
    detail: entry.own ? `${pr.repository.split("/").pop()}#${pr.number}` : `@${pr.author}`,
    time: age(entry.since.at, now), title: pr.title,
  }
}
