import { errorMessage } from "@opcode/core"
import { pasteIntoPrompt } from "@opcode/ui/paste"
import { snapshotRoute } from "@opcode/ui/screen"
import type { Context } from "@opencode/plugin/tui/context"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createSignal } from "solid-js"
import { AUTHORING_LEAD, authoringGuide, authoringRequest, authoringSession, parseCommand, type Authoring } from "./domain"
import type { SnippetsRemote } from "./rpc"
import type { SnippetEntry } from "./service"

const SESSIONS_NAVIGATE = "opcode-sessions.navigate"

interface BrowserState {
  rows: SnippetEntry[]
  loading: boolean
  error?: string
}

/** /snippets: a dialog to list, preview, insert, and delete snippets, and to open authoring sessions. Snippet data stays on the server. */
export function createBrowser(api: Context, remote: SnippetsRemote, render: () => JSX.Element) {
  const [state, setState] = createSignal<BrowserState>({ rows: [], loading: false })
  // The outlined snippet's key, kept here so it survives the list being replaced by a confirmation.
  const focus = createSignal<string>()
  const lifetime = new AbortController()
  let request: AbortController | undefined
  let opened = false
  const toast = (message: string, variant: "error" | "warning" | "success" | "info") => api.ui.toast.show({ title: "Snippets", message, variant })
  const location = () => api.location ?? api.data.location.default()

  function show() {
    if (lifetime.signal.aborted) return
    api.ui.dialog.show(render, () => { opened = false })
    opened = true
    api.ui.dialog.set({ size: "large", centered: true })
  }

  function close() {
    if (opened) api.ui.dialog.clear()
  }

  /**
   * Through the Sessions plugin when it is loaded, so its sidebar offers a way back to the session the user left. Its
   * command navigates synchronously, before anything else here navigates to the same session.
   */
  function navigate(sessionID: string) {
    if (api.keymap.commands().some((command) => command.id === SESSIONS_NAVIGATE)) api.keymap.dispatch(SESSIONS_NAVIGATE, sessionID)
    else api.ui.router.navigate({ type: "session", sessionID })
  }

  async function load() {
    request?.abort()
    const current = request = new AbortController()
    setState((value) => ({ ...value, loading: true }))
    try {
      const rows = await remote.list(AbortSignal.any([current.signal, lifetime.signal]))
      if (current === request) setState({ rows, loading: false })
    } catch (error) {
      if (current === request && !lifetime.signal.aborted) setState((value) => ({ ...value, loading: false, error: errorMessage(error) }))
    }
  }

  /**
   * A new session marked for authoring, whose snippet writes and deletes always ask first. A request is sent with its
   * instructions; without one, the instructions wait in the prompt for the user's message.
   */
  async function author(target: Authoring, request = "") {
    close()
    try {
      // Without a model, the server picks its own default rather than the one selected in the prompt.
      const chosen = api.ui.model.current()
      const model = chosen && { id: chosen.modelID, providerID: chosen.providerID, variant: chosen.variant }
      const session = await api.client.session.create({ location: location(), model, ...authoringSession(target) })
      if (lifetime.signal.aborted) return
      const destination = { type: "session", sessionID: session.id } as const
      navigate(session.id)
      const ask = request.trim()
      if (ask) {
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
    show()
    void load()
  }

  return {
    state, focus, load, author,
    shown: () => opened,
    async command(input = "") {
      const parsed = parseCommand(input)
      if (parsed.verb === "new") await author({}, parsed.request)
      else open()
    },
    /** Closes the dialog, then types `@name ` into the prompt under it. */
    async insert(row: SnippetEntry) {
      if (row.overridden || row.conflict) {
        toast(row.overridden ? `@${row.name} inserts the project snippet with the same name.` : `Another skill named ${row.name} replaces this snippet.`, "warning")
        return
      }
      const destination = snapshotRoute(api.ui.router.current())
      if (destination.type === "plugin") { toast("Open /snippets from home or a session to insert into its prompt.", "warning"); return }
      close()
      const result = await pasteIntoPrompt(api, destination, `@${row.name} `, () => !lifetime.signal.aborted, () => true, { signal: lifetime.signal })
      if (result === "unavailable") toast("The prompt is not ready. Open /snippets and try again.", "error")
    },
    async remove(row: SnippetEntry) {
      const confirmed = await api.ui.dialog.confirm({ title: `Delete @${row.name}?`, message: `This deletes ${row.path}.` })
      // The confirmation replaced the list. An answer brings the list back, reloaded, since skill updates aren't followed
      // while it is closed; a dialog that replaced the confirmation stays.
      if (confirmed === undefined || lifetime.signal.aborted) return
      show()
      if (confirmed) {
        try {
          const removed = await remote.remove({ name: row.name, scope: row.scope })
          toast(removed ? `Deleted @${row.name}.` : `@${row.name} was already gone.`, removed ? "success" : "info")
        } catch (error) { toast(errorMessage(error), "error") }
      }
      await load()
    },
    dispose() {
      close()
      lifetime.abort()
      request?.abort()
    },
  }
}

export type Browser = ReturnType<typeof createBrowser>
