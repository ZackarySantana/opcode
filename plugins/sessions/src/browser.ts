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
  loading: boolean
  syncing: boolean
  searchError: string
  syncError: string
}

/** Selection changes are local; asynchronous results cannot replace a newer query. */
export function createBrowser(client: HistorySource, remote: SessionsRemote) {
  const lifetime = new AbortController()
  const [state, setState] = createSignal<BrowserState>({ query: "", showSubagents: false, selected: 0, rows: [], projects: [], loading: false, syncing: false, searchError: "", syncError: "" })
  const patch = (value: Partial<BrowserState>) => { if (!lifetime.signal.aborted) setState((current) => ({ ...current, ...value })) }
  let search: AbortController | undefined
  let generation = 0
  let refreshing: Promise<void> | undefined

  async function load() {
    if (lifetime.signal.aborted) return
    const request = ++generation
    search?.abort()
    search = new AbortController()
    const signal = AbortSignal.any([search.signal, lifetime.signal])
    const value = state()
    try {
      validateQuery(value.query)
      patch({ loading: true, searchError: "" })
      const result = await remote.search({ query: value.query, projectID: value.projectID, showSubagents: value.showSubagents, limit: 200 }, signal)
      if (signal.aborted || request !== generation) return
      const current = state()
      const selectedID = current.rows[current.selected]?.id
      const position = selectedID ? result.rows.findIndex((row) => row.id === selectedID) : -1
      patch({ ...result, selected: position >= 0 ? position : clampSelection(current.selected, result.rows.length) })
    } catch (error) {
      if (!signal.aborted && request === generation) patch({ rows: [], selected: 0, searchError: errorMessage(error) })
    } finally { if (request === generation && !signal.aborted) patch({ loading: false }) }
  }

  function filters(value: Partial<Pick<BrowserState, "query" | "projectID" | "showSubagents">>) {
    patch({ ...value, rows: [], selected: 0 })
    return load()
  }

  function refresh() {
    if (refreshing || lifetime.signal.aborted) return refreshing ?? Promise.resolve()
    patch({ syncing: true, syncError: "" })
    refreshing = (async () => {
      try {
        await remote.refresh(lifetime.signal)
        await importHistory(client, remote, lifetime.signal)
      } catch (error) {
        if (!lifetime.signal.aborted) patch({ syncError: `Some history could not be synchronized: ${errorMessage(error)}` })
      } finally {
        patch({ syncing: false })
        if (!lifetime.signal.aborted) await load()
      }
    })().finally(() => { refreshing = undefined })
    return refreshing
  }

  return {
    state, load, filters, refresh,
    move(delta: number) { patch({ selected: clampSelection(state().selected + delta, state().rows.length) }) },
    reset() { return filters({ query: "", projectID: undefined, showSubagents: false }) },
    clear() { return filters({ query: "", projectID: undefined }) },
    async dispose() { lifetime.abort(); search?.abort(); await refreshing },
  }
}

export type BrowserModel = ReturnType<typeof createBrowser>
