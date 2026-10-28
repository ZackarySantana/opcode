import { errorMessage } from "@opcode/core"
import { Command, Plugin, type MountedSession } from "@opencode/plugin/gui"
import { authoringRequest, authoringSession, parseCommand, type Authoring } from "./domain"
import { en } from "./gui/i18n"
import { insertion, snippetOptions, type Choice } from "./gui/options"
import { describeError, snippetsRemote } from "./rpc"
import type { SnippetEntry } from "./service"

/** Snippets in the desktop app: pick one to type `@name ` into the prompt, write or edit one in a new chat, or delete one. */
export default Plugin.define({
  i18n: { en },
  setup(ctx) {
    const toast = (title: string, variant: "default" | "success" | "error" = "default", description?: string) =>
      ctx.toast.show({ title, variant, description })

    // Snippets come from the server that expands the session's `@name` mentions, for the session's directory.
    function current(): MountedSession | undefined {
      const session = ctx.sessions.current()
      if (!session) toast(ctx.t("toast.noSession"))
      return session
    }
    const remote = (session: MountedSession) => snippetsRemote(session.server.client, session.directory)

    async function choose(session: MountedSession, title: string, create: boolean): Promise<Choice | undefined> {
      let rows: SnippetEntry[]
      try { rows = await remote(session).list() } catch (error) {
        toast(ctx.t("toast.loadFailed"), "error", describeError(error))
        return undefined
      }
      if (!rows.length && !create) { toast(ctx.t("toast.empty")); return undefined }
      return ctx.dialogs.select({ title, placeholder: ctx.t("select.placeholder"), options: snippetOptions(rows, ctx.t, { create }) })
    }

    function insert(row: SnippetEntry) {
      const result = insertion(row)
      if ("blocked" in result) { toast(ctx.t(`insert.${result.blocked}`, { name: row.name })); return }
      const composer = ctx.screen.current()?.composer
      if (!composer) { toast(ctx.t("toast.noComposer")); return }
      composer.insert(result.text)
      composer.focus()
    }

    /**
     * A new session marked for authoring, whose snippet writes and deletes always ask first, opened in its own tab with
     * the instructions and the user's request as its first message.
     */
    async function author(session: MountedSession, target: Authoring, request = "") {
      const ask = request.trim() || await ctx.dialogs.prompt(target.name
        ? { title: ctx.t("author.edit.title", { name: target.name }) }
        : { title: ctx.t("author.new.title"), placeholder: ctx.t("author.new.placeholder") })
      if (!ask) return
      // Without a model, the server picks its own default rather than the one selected in the prompt.
      const chosen = ctx.screen.current()?.composer.model()
      const model = chosen && { id: chosen.modelID, providerID: chosen.providerID, variant: chosen.variant }
      const client = session.server.client
      try {
        const created = await client.session.create({ location: { directory: session.directory }, model, ...authoringSession(target) })
        ctx.tabs.open({ server: session.server.id, id: created.id }, { focus: true })
        await client.session.prompt({ sessionID: created.id, text: authoringRequest(target, ask) })
      } catch (error) { toast(ctx.t("author.failed"), "error", errorMessage(error)) }
    }

    async function remove(session: MountedSession, row: SnippetEntry) {
      const confirmed = await ctx.dialogs.confirm({
        title: ctx.t("delete.title", { name: row.name }),
        description: ctx.t("delete.description", { path: row.path }),
        confirm: ctx.t("delete.confirm"),
        danger: true,
      })
      if (!confirmed) return
      try {
        const removed = await remote(session).remove({ name: row.name, scope: row.scope })
        toast(ctx.t(removed ? "delete.done" : "delete.gone", { name: row.name }), removed ? "success" : "default")
      } catch (error) { toast(ctx.t("delete.failed", { name: row.name }), "error", describeError(error)) }
    }

    ctx.add(Command, (): Command => ({
      id: "open",
      title: ctx.t("command.open"),
      description: ctx.t("command.open.description"),
      keywords: "snippet prompt",
      section: "prompt",
      slash: { name: "snippets", arguments: true },
      run: async (input) => {
        const session = current()
        if (!session) return
        const parsed = parseCommand(input)
        if (parsed.verb === "new") return author(session, {}, parsed.request)
        const choice = await choose(session, ctx.t("select.title"), true)
        if (choice?.type === "new") await author(session, {})
        else if (choice) insert(choice.snippet)
      },
    }))

    ctx.add(Command, (): Command => ({
      id: "edit",
      title: ctx.t("command.edit"),
      keywords: "snippet",
      section: "prompt",
      run: async () => {
        const session = current()
        const choice = session && await choose(session, ctx.t("select.edit"), false)
        if (session && choice?.type === "snippet") await author(session, { name: choice.snippet.name, scope: choice.snippet.scope })
      },
    }))

    ctx.add(Command, (): Command => ({
      id: "delete",
      title: ctx.t("command.delete"),
      keywords: "snippet remove",
      section: "prompt",
      run: async () => {
        const session = current()
        const choice = session && await choose(session, ctx.t("select.delete"), false)
        if (session && choice?.type === "snippet") await remove(session, choice.snippet)
      },
    }))
  },
})
