import { errorMessage } from "@opcode/core"
import { Command, ComposerPill, createKeyed, MenuItem, Panel, Plugin, Style, type PanelTab, type SessionScreen } from "@opencode/plugin/gui"
import { createSignal, onCleanup } from "solid-js"
import { createRemote, LaterClient } from "./client"
import type { LaterItem } from "./domain"
import { en } from "./gui/i18n"
import { LaterPanel, type LaterActions } from "./gui/panel"
import { css } from "./gui/style"
import { launcherDescription, pillView, useItem, useToast } from "./gui/view"

const empty = { active: [], completed: [] } as const

/** Later in the desktop app: a side tab to manage the list, and a pill above the prompt to insert an item. */
export default Plugin.define({
  i18n: { en },
  setup(ctx) {
    const key = `${ctx.id}:list`
    const [later, setLater] = createSignal<LaterClient>()
    const [problem, setProblem] = createSignal<string>()
    const list = () => later()?.list() ?? empty

    // The list lives with the app's own server and is the same in every location. Calls go to the routed session's
    // directory when that session is on this server, and otherwise to the server's default location, so Home works
    // too. A restarted server has a new client.
    createKeyed(() => ctx.client, (client) => {
      const location = () => {
        const session = ctx.sessions.current()
        return session?.server.client === client ? { directory: session.directory } : undefined
      }
      const following = new LaterClient(createRemote(() => client, location), setProblem)
      following.start()
      setLater(following)
      onCleanup(() => following.dispose())
    })

    /** A change the server refused because the item changed elsewhere is reported, never retried on newer content. */
    async function write(change: (later: LaterClient) => Promise<boolean>, success?: string): Promise<boolean> {
      const current = later()
      if (!current) return false
      try {
        const changed = await change(current)
        if (!changed) ctx.toast.show({ title: ctx.t("toast.changed") })
        else if (success) ctx.toast.show({ variant: "success", title: success })
        return changed
      } catch (error) {
        ctx.toast.show({ variant: "error", title: ctx.t("toast.error"), description: errorMessage(error) })
        return false
      }
    }

    let using = false
    async function use(item: LaterItem, screen: SessionScreen | undefined) {
      const current = later()
      if (using || !current) return
      using = true
      try {
        const toast = useToast(await useItem(item, current.item(item.id), screen?.composer, current.complete))
        ctx.toast.show({ variant: toast.variant, title: ctx.t(toast.title), description: toast.description })
      } finally { using = false }
    }

    const actions: LaterActions = {
      add: (text) => write(async (later) => { await later.add(text); return true }),
      edit: async (item) => {
        const text = await ctx.dialogs.prompt({ title: ctx.t("edit.title"), value: item.message })
        if (text !== undefined) await write((later) => later.edit(item, text))
      },
      toggle: async (item) => {
        if (item.completedAt === undefined) await write((later) => later.complete(item), ctx.t("toast.completed"))
        else await write((later) => later.restore(item), ctx.t("toast.restored"))
      },
      remove: async (item) => {
        const confirmed = await ctx.dialogs.confirm({ title: ctx.t("delete.title"), description: item.message, confirm: ctx.t("delete.confirm"), danger: true })
        if (confirmed) await write((later) => later.delete(item), ctx.t("toast.deleted"))
      },
      // Moving past either end changes nothing, which is not a conflict.
      move: async (item, offset) => { await write(async (later) => { await later.move(item.id, offset); return true }) },
      use: (item) => use(item, ctx.screen.current()),
    }

    ctx.add(Style, css)

    const tab: PanelTab = {
      id: "list",
      get title() { return ctx.t("title") },
      closable: "compact",
    }
    ctx.add(Panel, {
      id: "list",
      region: "side",
      list: (input) => input.open.includes("list") ? [tab] : [],
      render: () => <LaterPanel list={list()} problem={problem()} actions={actions} />,
    })

    ctx.add(MenuItem, (): MenuItem => {
      const session = ctx.sessions.current()
      return {
        menu: "session.panel",
        id: "open",
        title: ctx.t("title"),
        icon: "checklist",
        keybind: `${ctx.id}.toggle`,
        description: launcherDescription(list().active),
        opened: !!session && ctx.layout.state(key, session) !== "closed",
        run: () => {
          const current = ctx.sessions.current()
          if (current) ctx.layout.open(key, current)
        },
      }
    })

    ctx.add(Command, (): Command => ({
      id: "toggle",
      title: ctx.t("command.toggle"),
      description: ctx.t("command.toggle.description"),
      keywords: "deferred prompts queue",
      slash: { name: "later" },
      enabled: !!ctx.sessions.current(),
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.toggle(key, session)
      },
    }))

    ctx.add(ComposerPill, {
      id: "items",
      show: (input) => {
        const active = list().active
        return pillView(active, { label: ctx.plural("pill.label", active.length), title: ctx.t("pill.title") },
          (item) => void use(item, input.screen))
      },
    })
  },
})
