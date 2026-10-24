import { localDay, type ActivityKind, type LongTurn, type TimeBreakdown, type TimeDashboard } from "./domain.js"

/** One waiting gap counts at most this long, so a night away is not "waiting on you". */
export const WAIT_CAP = 30 * 60_000

/** A recorded step carries the model that produced it; markers only carry their time. */
export type TimelineEvent =
  | { kind: ActivityKind; at: number }
  | { kind: "step"; at: number; end: number; model: string; variant?: string; output: number }

export interface Turn {
  sessionID: string
  start: number
  end: number
  /** `provider/model` of the step with the most output, matching the dashboard model filter. */
  model?: string
  variant?: string
  /** Waiting on you after this turn went idle, until the next user prompt. */
  wait: number
}

/**
 * Busy periods of one root session, from events sorted by time (idle first on ties). A turn starts at
 * the first prompt or step after idle, so a turn woken by a synthetic message (such as a background
 * subagent finishing) starts at its first step and leaves no waiting gap.
 */
export function deriveTurns(sessionID: string, events: readonly TimelineEvent[]): Turn[] {
  const turns: Turn[] = []
  let turn: { start: number; last: number; output: Map<string, { model: string; variant?: string; output: number }> } | undefined
  let idleAt: number | undefined
  const close = (end: number) => {
    let top: { model: string; variant?: string; output: number } | undefined
    for (const entry of turn!.output.values()) if (!top || entry.output > top.output) top = entry
    turns.push({ sessionID, start: turn!.start, end, model: top?.model, variant: top?.variant, wait: 0 })
    turn = undefined
  }
  for (const event of events) {
    if (event.kind === "idle") {
      // An idle without a turn ended work with no recorded step, such as a wake: a wait starts after it.
      if (turn) close(event.at)
      idleAt = event.at
      continue
    }
    // A prompt long after the last activity means the idle was never recorded: history has none for a server shutdown.
    if (turn && event.kind === "prompt" && event.at - turn.last > WAIT_CAP) close(turn.last)
    if (!turn) {
      const previous = turns.at(-1)
      if (event.kind === "prompt" && idleAt !== undefined && previous) previous.wait = Math.min(event.at - idleAt, WAIT_CAP)
      turn = { start: event.at, last: event.at, output: new Map() }
      idleAt = undefined
    }
    if (event.kind === "step") {
      turn.last = Math.max(turn.last, event.end)
      const key = `${event.model}\n${event.variant ?? ""}`
      const entry = turn.output.get(key) ?? { model: event.model, variant: event.variant, output: 0 }
      turn.output.set(key, { ...entry, output: entry.output + event.output })
    } else turn.last = Math.max(turn.last, event.at)
  }
  // A running turn (or one whose idle is missing) counts up to its latest recorded activity.
  if (turn) close(turn.last)
  return turns
}

/** Time with two or more turns running at once, and the most at any moment. */
export function overlap(turns: readonly Pick<Turn, "start" | "end">[]) {
  // Ends sort before starts at the same moment: back-to-back turns do not overlap.
  const edges = turns.flatMap((turn) => [[turn.start, 1], [turn.end, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let running = 0
  let peak = 0
  let parallel = 0
  let previous = 0
  for (const [at, change] of edges) {
    if (running >= 2) parallel += at - previous
    running += change
    peak = Math.max(peak, running)
    previous = at
  }
  return { parallel, peak }
}

export interface TimedTurn extends Turn {
  title?: string
  projectID: string
  project: string
  directory: string
}

/** Turns are attributed to their start time, like usage to message creation. */
export function summarizeTime(turns: readonly TimedTurn[]): TimeDashboard {
  const duration = (turn: Turn) => turn.end - turn.start
  const modelLabel = (turn: Turn) => turn.model ? turn.variant ? `${turn.model} (${turn.variant})` : turn.model : "no recorded step"
  const group = (key: (turn: TimedTurn) => string, label: (turn: TimedTurn) => string) => {
    const rows = new Map<string, TimeBreakdown>()
    for (const turn of turns) {
      const id = key(turn)
      const row = rows.get(id) ?? { id, label: label(turn), agent: 0, wait: 0, turns: 0 }
      row.agent += duration(turn)
      row.wait += turn.wait
      row.turns++
      rows.set(id, row)
    }
    return [...rows.values()]
  }
  const ranked = (rows: TimeBreakdown[]) => rows.sort((a, b) => b.agent - a.agent || a.label.localeCompare(b.label)).slice(0, 8)
  const longest: LongTurn[] = [...turns].sort((a, b) => duration(b) - duration(a) || b.start - a.start).slice(0, 8).map((turn) => ({
    sessionID: turn.sessionID, title: turn.title ?? turn.sessionID, project: turn.project, directory: turn.directory,
    model: modelLabel(turn), start: turn.start, duration: duration(turn),
  }))
  return {
    total: {
      agent: turns.reduce((sum, turn) => sum + duration(turn), 0),
      turns: turns.length,
      wait: turns.reduce((sum, turn) => sum + turn.wait, 0),
      ...overlap(turns),
    },
    projects: ranked(group((turn) => turn.projectID, (turn) => turn.project)),
    models: ranked(group(modelLabel, modelLabel)),
    daily: group((turn) => localDay(turn.start), (turn) => localDay(turn.start)).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 14),
    longest,
  }
}
