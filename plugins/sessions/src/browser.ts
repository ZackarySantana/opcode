import { createSignal } from "solid-js"
import { errorMessage } from "@opcode/core"
import { clampSelection, type ProjectOption, type SessionResult } from "./domain"
import { importHistory, type HistorySource } from "./history"
import type { SessionsRemote } from "./rpc"
import { validateQuery } from "./regex"

export interface BrowserState {
  query: string
  projectID?: string
  showSubagents: boolean
  selected: number
  rows: SessionResult[]
  projects: ProjectOption[]
  /** The server's scan budget expired: rows are partial. */
  truncated: boolean
  /** Rows still answer an earlier query while the latest search runs. */
  outdated: boolean
  loading: boolean
  syncing: boolean
  searchError: string
  syncError: string
  /** Non-failure synchronization outcome, such as busy sessions left for later. */
  syncNotice: string
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** Selection changes are local; asynchronous results cannot replace a newer query. */
export function createBrowser(client: HistorySource, remote: SessionsRemote) {
  const lifetime = new AbortController()
  const [state, setState] = createSignal<BrowserState>({ query: "", showSubagents: false, selected: 0, rows: [], projects: [], truncated: false, outdated: false, loading: false, syncing: false, searchError: "", syncError: "", syncNotice: "" })
  const patch = (value: Partial<BrowserState>) => { if (!lifetime.signal.aborted) setState((current) => ({ ...current, ...value })) }
  let searching: AbortController | undefined
  let generation = 0
  let refreshing: Promise<void> | undefined
  let synchronized = false

  async function load() {
    if (lifetime.signal.aborted) return
    const request = ++generation
    searching?.abort()
    searching = new AbortController()
    const signal = AbortSignal.any([searching.signal, lifetime.signal])
    const value = state()
    try {
      validateQuery(value.query)
      patch({ loading: true, searchError: "" })
      const result = await remote.search({ query: value.query, projectID: value.projectID, showSubagents: value.showSubagents, limit: 200 }, signal)
      if (signal.aborted || request !== generation) return
      const current = state()
      const selectedID = current.rows[current.selected]?.id
      const position = selectedID ? result.rows.findIndex((row) => row.id === selectedID) : -1
      patch({ ...result, outdated: false, selected: position >= 0 ? position : clampSelection(current.selected, result.rows.length) })
    } catch (error) {
      if (!signal.aborted && request === generation) patch({ rows: [], selected: 0, truncated: false, outdated: false, searchError: errorMessage(error) })
    } finally { if (request === generation && !signal.aborted) patch({ loading: false }) }
  }

  function filters(value: Partial<Pick<BrowserState, "query" | "projectID" | "showSubagents">>) {
    patch({ ...value, rows: [], selected: 0, truncated: false })
    return load()
  }

  /** Typing refines the query in place: the rows shown stay, marked outdated, until the new results replace them. */
  function search(query: string) {
    patch({ query, outdated: true })
    return load()
  }

  /** Server failures for individual sessions are counted, and history import still runs after them. */
  function refresh() {
    if (refreshing || lifetime.signal.aborted) return refreshing ?? Promise.resolve()
    synchronized = true
    patch({ syncing: true, syncError: "", syncNotice: "" })
    refreshing = (async () => {
      const errors: string[] = []
      const notices: string[] = []
      try {
        const server = await remote.refresh(lifetime.signal)
        if (server.failed) errors.push(`${plural(server.failed, "session")} could not be indexed`)
        if (server.deferred) notices.push(`${plural(server.deferred, "busy session")} will be indexed when idle`)
      } catch (error) { errors.push(`server refresh failed: ${errorMessage(error)}`) }
      try {
        if (!lifetime.signal.aborted) {
          const history = await importHistory(client, remote, lifetime.signal)
          if (history.skipped) notices.push(`${plural(history.skipped, "changed session")} left for the next history import`)
          if (history.oversized) notices.push(`${plural(history.oversized, "message")} over 1 MiB not indexed`)
        }
      } catch (error) { errors.push(`history import stopped: ${errorMessage(error)}`) }
      patch({ syncing: false, syncError: errors.length ? `Some history could not be synchronized: ${errors.join("; ")}.` : "", syncNotice: notices.join("; ") })
      await load()
    })().finally(() => { refreshing = undefined })
    return refreshing
  }

  return {
    state, load, filters, search, refresh,
    move(delta: number) { patch({ selected: clampSelection(state().selected + delta, state().rows.length) }) },
    /** Opening resets filters; the first opening also synchronizes, so launching a TUI stays cheap. */
    activate() {
      const reset = filters({ query: "", projectID: undefined, showSubagents: false })
      if (!synchronized) void refresh()
      return reset
    },
    clear() { return filters({ query: "", projectID: undefined }) },
    async dispose() { lifetime.abort(); searching?.abort(); await refreshing },
  }
}

export type BrowserModel = ReturnType<typeof createBrowser>
