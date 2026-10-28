import type { ComposerPillRow, ComposerPillTone, ComposerPillView, IconName, Params } from "@opencode/plugin/gui"
import { onTeam, ordered, sidebarEntries, type Entry, type Settings, type Snapshot, type Tone, type View } from "../model"

/** The plugin's copy, as `ctx.t` and `ctx.plural` read it. */
export interface Copy {
  t(key: string, params?: Params): string
  plural(key: string, count: number, params?: Params): string
}

/** What the views read from `PullRequestsClient`: its lists already leave out inactive pull requests. */
export interface Shown {
  readonly snapshot?: Snapshot
  readonly view: View
  readonly settings: Settings
  readonly error?: string
}

const tones: Partial<Record<Tone, ComposerPillTone>> = { urgent: "danger", attention: "warning", ready: "success" }
const icons: Record<ComposerPillTone, IconName> = { danger: "circle-x", warning: "circle-exclamation", success: "circle-check" }
const rank: readonly (ComposerPillTone | undefined)[] = [undefined, "success", "warning", "danger"]

/** Red for your blocked pull requests, yellow for reviews waiting on you, green for approved ones; none otherwise. */
export const entryTone = (entry: Entry): ComposerPillTone | undefined => tones[entry.tone]

/** What waits on you, as the TUI sidebar lists it (following its settings and team filter), in the chosen order. */
export const waiting = (shown: Shown): Entry[] => sidebarEntries(shown.view, shown.settings).filter((entry) => entry.pending)

const where = (entry: Entry) => `${entry.pr.repository.split("/").pop()}#${entry.pr.number}`

/**
 * The pill above the composer: what waits on you, up to the sidebar's item count, and why pull requests can't be
 * read. Nothing to show leaves no pill.
 */
export function pillView(shown: Shown, copy: Copy, actions: {
  open(url: string): void
  refresh(): void
  /** Opens everything, past the rows the pill lists. */
  more(): void
}): ComposerPillView | undefined {
  const entries = waiting(shown)
  const { error } = shown
  if (!entries.length && !error) return undefined
  const limit = shown.settings.sidebarItems
  const rows: ComposerPillRow[] = [
    ...error ? [{ id: "error", label: error, icon: "warning", tone: "danger", detail: copy.t("pill.retry"), run: actions.refresh } satisfies ComposerPillRow] : [],
    ...entries.slice(0, limit).map((entry): ComposerPillRow => {
      const tone = entryTone(entry)
      return { id: entry.pr.url, label: entry.pr.title, icon: tone ? icons[tone] : "status", tone, detail: `${entry.label} · ${where(entry)}`, run: () => actions.open(entry.pr.url) }
    }),
    ...entries.length > limit ? [{ id: "more", label: copy.plural("pill.more", entries.length - limit), run: actions.more }] : [],
  ]
  const worst = error ? "danger" : entries.map(entryTone).reduce((a, b) => rank.indexOf(b) > rank.indexOf(a) ? b : a, undefined)
  return {
    icon: "github",
    label: entries.length ? copy.plural("pill.waiting", entries.length) : copy.t("pill.error"),
    tone: worst,
    title: copy.t("pill.title"),
    rows,
  }
}

export interface Option {
  readonly title: string
  readonly description: string
  /** The pull request's URL. */
  readonly value: string
  readonly group: string
}

/** Every pull request, grouped as the TUI's tabs group them, each group in the chosen order. */
export function selectOptions(shown: Shown, copy: Copy): Option[] {
  const current = shown.view
  const { team, order } = shown.settings
  const groups: [string, Params | undefined, readonly Entry[]][] = [
    ["group.mine.pending", undefined, current.mine.filter((entry) => entry.pending)],
    ["group.mine.waiting", undefined, current.mine.filter((entry) => !entry.pending && !entry.pr.draft)],
    ["group.mine.drafts", undefined, current.mine.filter((entry) => entry.pr.draft)],
    ["group.reviewing.pending", undefined, current.reviewing.filter((entry) => entry.pending)],
    ["group.reviewing.done", undefined, current.reviewing.filter((entry) => !entry.pending)],
    team ? ["group.team", { team }, onTeam(current.teams, team)] : ["group.teams", undefined, current.teams],
  ]
  return groups.flatMap(([key, params, entries]) => ordered(entries, order).map((entry) => ({
    title: entry.pr.title,
    description: entry.own ? `${entry.label} · ${entry.pr.repository}#${entry.pr.number}` : `${entry.label} · @${entry.pr.author} · ${entry.pr.repository}#${entry.pr.number}`,
    value: entry.pr.url,
    group: copy.t(key, params),
  })))
}
