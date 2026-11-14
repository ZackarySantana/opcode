import { Command, Plugin, Style, type DialogHandle, type MountedSession } from "@opencode/plugin/gui"
import { onCleanup } from "solid-js"
import { parseCommand } from "./domain"
import { snippetActions, type SnippetActions } from "./gui/actions"
import { SnippetsDialog } from "./gui/dialog"
import { newStart, type EditorStart } from "./gui/draft"
import { en } from "./gui/i18n"
import { css } from "./gui/style"
import { describeError, snippetsRemote } from "./rpc"

/**
 * Snippets in the desktop app: a dialog to find, insert, write, edit, and delete them; commands that turn the prompt or
 * a message into one; and `/snippets save`, which asks the session's agent to write one with its snippet tools.
 */
export default Plugin.define({
  i18n: { en },
  setup(ctx) {
    const toast = (title: string) => { ctx.toast.show({ title }) }

    // Snippets come from the server that expands the session's `@name` mentions, for the session's directory.
    function current(): MountedSession | undefined {
      const session = ctx.sessions.current()
      if (!session) toast(ctx.t("toast.noSession"))
      return session
    }

    function actionsFor(session: MountedSession): { actions: SnippetActions; remote: ReturnType<typeof snippetsRemote> } {
      const client = session.server.client
      const remote = snippetsRemote(client, session.directory)
      const actions = snippetActions({
        t: ctx.t,
        toast: (options) => { ctx.toast.show(options) },
        confirm: (options) => ctx.dialogs.confirm(options),
        select: (options) => ctx.dialogs.select(options),
        composer: () => ctx.screen.current()?.composer,
        remote,
        describeError,
        prompt: (text) => client.session.prompt({ sessionID: session.id, text }),
        messages: async () => (await client.message.list({ sessionID: session.id, order: "desc", limit: 100 })).data,
      })
      return { actions, remote }
    }

    let dialog: DialogHandle | undefined
    /** One snippets dialog at a time; opening another replaces it. */
    function open(session: MountedSession, options: { editor?: EditorStart; onSaved?: (name: string) => void } = {}) {
      dialog?.close()
      const { actions, remote } = actionsFor(session)
      const handle = ctx.dialogs.open((self) => {
        onCleanup(() => { if (dialog === handle) dialog = undefined })
        return <SnippetsDialog remote={remote} actions={actions} describeError={describeError} editor={options.editor} onSaved={options.onSaved} close={() => self.close()} />
      })
      dialog = handle
    }

    ctx.add(Style, css)

    ctx.add(Command, (): Command => ({
      id: "open",
      title: ctx.t("command.open"),
      description: ctx.t("command.open.description"),
      keywords: "snippet prompt new save",
      section: "prompt",
      slash: { name: "snippets", arguments: true },
      run: async (input) => {
        const session = current()
        if (!session) return
        const parsed = parseCommand(input)
        if (parsed.verb === "new") open(session, { editor: newStart() })
        else if (parsed.verb === "save") await actionsFor(session).actions.askAgent(parsed.request)
        else open(session)
      },
    }))

    ctx.add(Command, (): Command => ({
      id: "save-prompt",
      title: ctx.t("command.savePrompt"),
      description: ctx.t("command.savePrompt.description"),
      keywords: "snippet draft",
      section: "prompt",
      enabled: !!ctx.sessions.current(),
      run: () => {
        const session = current()
        if (!session) return
        const text = ctx.screen.current()?.composer.text() ?? ""
        if (!text.trim()) { toast(ctx.t("toast.emptyPrompt")); return }
        const { actions } = actionsFor(session)
        open(session, { editor: newStart(text), onSaved: (name) => void actions.offerReplace(name) })
      },
    }))

    ctx.add(Command, (): Command => ({
      id: "save-message",
      title: ctx.t("command.saveMessage"),
      description: ctx.t("command.saveMessage.description"),
      keywords: "snippet reply",
      section: "prompt",
      enabled: !!ctx.sessions.current(),
      run: async () => {
        const session = current()
        if (!session) return
        const message = await actionsFor(session).actions.pickMessage()
        if (message) open(session, { editor: newStart(message.text) })
      },
    }))
  },
})
