import { errorMessage } from "@opcode/core"
import { pasteIntoPrompt } from "@opcode/ui/paste"
import { createScreen, type Screen } from "@opcode/ui/screen"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { AUTHORING_LEAD, authoringGuide, authoringRequest, authoringSession, PLUGIN_ID, type Authoring } from "./domain"
import type { SnippetsRemote } from "./rpc"
import type { SnippetEntry } from "./service"

export const LIST_ROUTE = "opcode-snippets.list"
export const LIST_MODE = "opcode-snippets.list"

export interface BrowserState {
  rows: SnippetEntry[]
  selected: number
  loading: boolean
  error?: string
}

/** /snippets: list, preview, insert, delete, and open authoring sessions. Snippet data stays on the server. */
export function createBrowser(api: Context, remote: SnippetsRemote) {
  const screen: Screen = createScreen(api, { id: PLUGIN_ID, name: LIST_ROUTE, mode: LIST_MODE })
  const [state, setState] = createSignal<BrowserState>({ rows: [], selected: 0, loading: false })
  const lifetime = new AbortController()
  let request: AbortController | undefined
  const toast = (message: string, variant: "error" | "warning" | "success" | "info") => api.ui.toast.show({ title: "Snippets", message, variant })
  const location = () => api.location ?? api.data.location.default()
  const selected = () => state().rows[state().selected]

  async function load() {
    request?.abort()
    const current = request = new AbortController()
    setState((value) => ({ ...value, loading: true }))
    try {
      const rows = await remote.list(AbortSignal.any([current.signal, lifetime.signal]))
      if (current !== request) return
      const name = selected()?.name
      const scope = selected()?.scope
      const index = rows.findIndex((row) => row.name === name && row.scope === scope)
      setState({ rows, selected: Math.max(0, Math.min(index >= 0 ? index : state().selected, rows.length - 1)), loading: false })
    } catch (error) {
      if (current === request && !lifetime.signal.aborted) setState((value) => ({ ...value, loading: false, error: errorMessage(error) }))
    }
  }

  /**
   * A new session marked for authoring, whose snippet writes and deletes always ask first. A request is sent with its
   * instructions; without one, the instructions wait in the prompt for the user's message.
   */
  async function author(target: Authoring, request = "") {
    try {
      // Without a model, the server picks its own default rather than the one selected in the prompt.
      const chosen = api.ui.model.current()
      const model = chosen && { id: chosen.modelID, providerID: chosen.providerID, variant: chosen.variant }
      const session = await api.client.session.create({ location: location(), model, ...authoringSession(target) })
      if (lifetime.signal.aborted) return
      screen.invalidate()
      const destination = { type: "session", sessionID: session.id } as const
      const ask = request.trim()
      if (ask) {
        api.ui.router.navigate(destination)
        await api.client.session.prompt({ sessionID: session.id, text: authoringRequest(target, ask) })
        return
      }
      // The host collapses the multi-line guide into a "pasted N lines" placeholder; the one-line lead after it stays readable.
      const parts = [authoringGuide(target), AUTHORING_LEAD]
      const result = await pasteIntoPrompt(api, destination, parts, () => !lifetime.signal.aborted, () => true, { signal: lifetime.signal })
      if (result === "unavailable") toast("The snippet session opened, but its prompt wasn't ready for the instructions.", "error")
    } catch (error) { toast(`Could not start a snippet session: ${errorMessage(error)}`, "error") }
  }

  function open() {
    if (screen.owns()) return
    screen.open()
    void load()
  }

  return {
    screen, state, selected, load, author, open,
    /** `/snippets new [what it should do]` starts authoring; anything else opens the list. */
    async command(input = "") {
      const [, verb, request] = /^\s*(?:\/\S+)?\s*(\S*)\s*([\s\S]*)$/.exec(input) ?? []
      if (verb === "new") await author({}, request)
      else open()
    },
    move(delta: number) {
      setState((value) => ({ ...value, selected: Math.max(0, Math.min(value.selected + delta, value.rows.length - 1)) }))
    },
    async insert() {
      const row = selected()
      if (!row) return
      if (row.overridden || row.conflict) {
        toast(row.overridden ? `#${row.name} inserts the project snippet with the same name.` : `Another skill named ${row.name} replaces this snippet.`, "warning")
        return
      }
      const back = screen.previous()
      if (back.type === "plugin") { toast("Open /snippets from home or a session to insert into its prompt.", "warning"); return }
      const result = await pasteIntoPrompt(api, back, `#${row.name} `, () => !lifetime.signal.aborted, () => true, { signal: lifetime.signal })
      if (result === "unavailable") toast("The prompt is not ready. Open /snippets and try again.", "error")
    },
    async edit() {
      const row = selected()
      if (row) await author({ name: row.name, scope: row.scope })
    },
    async remove() {
      const row = selected()
      if (!row) return
      const valid = screen.interaction()
      const confirmed = await api.ui.dialog.confirm({ title: `Delete #${row.name}?`, message: `This deletes ${row.path}.` })
      if (!confirmed || !valid()) return
      try {
        const removed = await remote.remove({ name: row.name, scope: row.scope })
        toast(removed ? `Deleted #${row.name}.` : `#${row.name} was already gone.`, removed ? "success" : "info")
      } catch (error) { toast(errorMessage(error), "error") }
      await load()
    },
    dispose() {
      lifetime.abort()
      request?.abort()
      screen.dispose()
    },
  }
}

export type Browser = ReturnType<typeof createBrowser>
