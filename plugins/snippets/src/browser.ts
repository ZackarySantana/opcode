import { pasteIntoPrompt } from "@opcode/ui/paste"
import { snapshotRoute } from "@opcode/ui/screen"
import { shorten } from "@opcode/ui"
import type { Context } from "@opencode/plugin/tui/context"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createSignal } from "solid-js"
import { draftOf, duplicateOf, emptyDraft, messageChoices, sameDraft, saveRequest, type Draft } from "./draft"
import { parseCommand, SAVE_LEAD } from "./domain"
import { describeError, type SnippetsRemote } from "./rpc"
import type { SnippetEntry, SnippetKey } from "./service"

interface BrowserState {
  rows: SnippetEntry[]
  loading: boolean
  error?: string
}

export type Field = "name" | "scope" | "description" | "aliases" | "body"
export const fields: readonly Field[] = ["name", "scope", "description", "aliases", "body"]

/** A snippet being written in the editor. Kept here so it survives the editor being replaced by a confirmation. */
export interface Editing {
  draft: Draft
  initial: Draft
  /** The snippet being edited, which a save replaces. */
  from?: SnippetKey
  /** Whether esc returns to the list rather than closing the dialog. */
  back: boolean
  field: Field
  saving: boolean
  error?: string
}

export const keyOf = (row: SnippetKey) => `${row.scope}/${row.name}`

/**
 * /snippets: a dialog to list, preview, insert, write, and delete snippets, and to ask the session's agent to save one.
 * Snippet data stays on the server.
 */
export function createBrowser(api: Context, remote: SnippetsRemote, render: () => JSX.Element) {
  const [state, setState] = createSignal<BrowserState>({ rows: [], loading: false })
  const [editing, setEditing] = createSignal<Editing>()
  // The outlined snippet's key, kept here so it survives the list being replaced by a confirmation.
  const focus = createSignal<string>()
  const lifetime = new AbortController()
  let request: AbortController | undefined
  let opened = false
  const toast = (message: string, variant: "error" | "warning" | "success" | "info") => api.ui.toast.show({ title: "Snippets", message, variant })
  const paste = (destination: Parameters<typeof pasteIntoPrompt>[1], text: string) =>
    pasteIntoPrompt(api, destination, text, () => !lifetime.signal.aborted, () => true, { signal: lifetime.signal })

  function show() {
    if (lifetime.signal.aborted) return
    api.ui.dialog.show(render, () => { opened = false })
    opened = true
    api.ui.dialog.set({ size: "xlarge", centered: true })
  }

  function close() {
    if (opened) api.ui.dialog.clear()
  }

  async function load() {
    request?.abort()
    const current = request = new AbortController()
    setState((value) => ({ ...value, loading: true }))
    try {
      const { snippets } = await remote.list(AbortSignal.any([current.signal, lifetime.signal]))
      if (current === request) setState({ rows: snippets, loading: false })
    } catch (error) {
      if (current === request && !lifetime.signal.aborted) setState((value) => ({ ...value, loading: false, error: describeError(error) }))
    }
  }

  function open() {
    setEditing(undefined)
    show()
    void load()
  }

  /** Opens the editor in the dialog, over the list when `back`. */
  function write(draft: Draft, options: { from?: SnippetKey; back: boolean }) {
    setEditing({ draft, initial: draft, from: options.from, back: options.back, field: "name", saving: false })
    if (!opened) show()
  }

  /** Leaves the editor for the list, or closes the dialog when the editor was opened on its own. */
  function leave(current: Editing) {
    setEditing(undefined)
    if (!current.back) { close(); return }
    if (!opened) show()
    void load()
  }

  async function save() {
    const current = editing()
    if (!current || current.saving) return
    const input = saveRequest(current.draft, current.from)
    setEditing({ ...current, saving: true, error: undefined })
    try {
      const result = await remote.save(input)
      if (lifetime.signal.aborted || editing()?.initial !== current.initial) return
      toast(result.breaks.length
        ? `Saved @${input.name}. References in ${result.breaks.map((name) => `@${name}`).join(", ")} no longer expand.`
        : `Saved @${input.name}.`, result.breaks.length ? "warning" : "success")
      focus[1](keyOf(input))
      leave({ ...current, back: true })
    } catch (error) {
      const latest = editing()
      if (latest?.initial === current.initial) setEditing({ ...latest, saving: false, error: describeError(error) })
    }
  }

  async function cancel() {
    const current = editing()
    if (!current) return
    if (!sameDraft(current.draft, current.initial)) {
      const discard = await api.ui.dialog.confirm({
        title: "Discard changes?",
        message: current.from ? `Your changes to @${current.from.name} are not saved.` : "This snippet is not saved.",
        label: { confirm: "Discard", cancel: "Keep editing" },
      })
      // The confirmation replaced the editor; a dialog that replaced the confirmation stays.
      if (discard === undefined || lifetime.signal.aborted) return
      if (!discard) { show(); return }
    }
    leave(current)
  }

  /** Picks one of the current session's messages, then opens the editor with its text. */
  async function saveMessage(back: boolean) {
    const route = snapshotRoute(api.ui.router.current())
    if (route.type !== "session") { toast("Open a session to save one of its messages as a snippet.", "warning"); return }
    let messages = api.data.session.message.list(route.sessionID)
    if (!messages.length) {
      await api.data.session.message.sync(route.sessionID).catch(() => {})
      messages = api.data.session.message.list(route.sessionID)
    }
    const choices = messageChoices(messages).slice(0, 50)
    if (!choices.length) { toast("This session has no messages with text yet.", "info"); return }
    const body = await api.ui.dialog.select({
      title: "Save a message as a snippet",
      placeholder: "search messages",
      options: choices.map((choice) => ({
        title: shorten(choice.text.replace(/\s+/g, " "), 100),
        description: choice.role === "user" ? "You" : "Assistant",
        value: choice.text,
      })),
    })
    if (lifetime.signal.aborted) return
    // The picker replaced the list; without a pick, esc goes back to it.
    if (body === undefined) { if (back) show(); return }
    write(emptyDraft(body), { back })
  }

  /** `/snippets save`: the session's agent writes the snippet with its tools, asking first. */
  async function askAgent(ask: string) {
    close()
    try {
      if (!(await remote.list(lifetime.signal)).agentTools) {
        toast("The agent's snippet tools are off (plugin option agentTools), so it can't save snippets.", "warning")
        return
      }
    } catch (error) {
      if (!lifetime.signal.aborted) toast(describeError(error), "error")
      return
    }
    const route = snapshotRoute(api.ui.router.current())
    if (ask && route.type === "session") {
      try { await api.client.session.prompt({ sessionID: route.sessionID, text: SAVE_LEAD + ask }) }
      catch (error) { toast(`Could not ask the agent: ${describeError(error)}`, "error") }
      return
    }
    if (route.type === "plugin") { toast("Run /snippets save from a session to ask its agent.", "warning"); return }
    // Without a request, the lead waits in the prompt for the user to say what to save.
    const result = await paste(route, SAVE_LEAD + ask)
    if (result === "unavailable") toast("The prompt is not ready. Run /snippets save again.", "error")
  }

  return {
    state, focus, editing, load, save, cancel,
    shown: () => opened,
    async command(input = "") {
      const parsed = parseCommand(input)
      if (parsed.verb === "new") write(emptyDraft(), { back: false })
      else if (parsed.verb === "save") await askAgent(parsed.request)
      else open()
    },
    create: () => write(emptyDraft(), { back: true }),
    edit: (row: SnippetEntry) => write(draftOf(row), { from: { name: row.name, scope: row.scope }, back: true }),
    duplicate: (row: SnippetEntry) => write(duplicateOf(row, state().rows), { back: true }),
    saveMessage,
    /** Changes the editor's draft or focused field; an edit clears a save error. */
    update(change: { draft?: Partial<Draft>; field?: Field }) {
      const current = editing()
      if (!current) return
      setEditing({
        ...current,
        ...change.field ? { field: change.field } : {},
        ...change.draft ? { draft: { ...current.draft, ...change.draft }, error: undefined } : {},
      })
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
      const result = await paste(destination, `@${row.name} `)
      if (result === "unavailable") toast("The prompt is not ready. Open /snippets and try again.", "error")
    },
    async remove(row: SnippetEntry) {
      const users = row.breaks.length ? ` ${row.breaks.map((name) => `@${name}`).join(", ")} will keep @${row.name} as typed.` : ""
      const confirmed = await api.ui.dialog.confirm({ title: `Delete @${row.name}?`, message: `This deletes ${row.path}.${users}` })
      // The confirmation replaced the list. An answer brings the list back, reloaded, since skill updates aren't followed
      // while it is closed; a dialog that replaced the confirmation stays.
      if (confirmed === undefined || lifetime.signal.aborted) return
      show()
      if (confirmed) {
        try {
          const removed = await remote.remove({ name: row.name, scope: row.scope })
          toast(removed ? `Deleted @${row.name}.` : `@${row.name} was already gone.`, removed ? "success" : "info")
        } catch (error) { toast(describeError(error), "error") }
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
