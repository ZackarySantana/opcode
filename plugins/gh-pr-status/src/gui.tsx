import { Command, ComposerPill, createKeyed, Plugin } from "@opencode/plugin/gui"
import { createSignal, onCleanup } from "solid-js"
import { createRemote, PullRequestsClient } from "./client"
import { pickable } from "./gui/actions"
import { en } from "./gui/i18n"
import { pillView, type Shown } from "./gui/view"

export default Plugin.define({
  i18n: { en },
  setup(ctx) {
    const [current, setCurrent] = createSignal<PullRequestsClient>()

    // A restarted server comes back with a new client, and its announcements start over: follow it afresh.
    createKeyed(() => ctx.client, (client) => {
      // The state is the same in every location, so calls go to the routed session's directory, and on Home, with no
      // session, to the server's default location, which the RPC client allows by leaving the location out.
      const remote = createRemote(() => client, () => {
        const directory = ctx.sessions.current()?.directory
        return directory ? { directory } : undefined
      })
      const prs = new PullRequestsClient(remote)
      prs.start()
      setCurrent(prs)
      onCleanup(() => prs.dispose())
    })

    const shown = (): Shown | undefined => {
      const prs = current()
      return prs && { snapshot: prs.snapshot(), view: prs.view(), settings: prs.settings(), error: prs.error() }
    }
    const refresh = () => current()?.refresh()

    const pick = async () => {
      const now = shown()
      const found = now ? pickable(now, ctx) : { title: ctx.t("select.loading"), error: false }
      if (!("options" in found)) {
        ctx.toast.show({ variant: found.error ? "error" : "default", title: found.title, description: found.description })
        return
      }
      const url = await ctx.dialogs.select({ title: ctx.t("select.title"), placeholder: ctx.t("select.placeholder"), options: found.options })
      if (url) ctx.system.openExternal(url)
    }

    ctx.add(Command, (): Command => ({
      id: "open",
      title: ctx.t("command.open"),
      description: ctx.t("command.open.description"),
      keywords: ctx.t("command.keywords"),
      group: ctx.t("command.group"),
      slash: { name: "ghpr" },
      run: () => void pick(),
    }))
    ctx.add(Command, (): Command => ({
      id: "refresh",
      title: ctx.t("command.refresh"),
      keywords: ctx.t("command.keywords"),
      group: ctx.t("command.group"),
      run: refresh,
    }))

    ctx.add(ComposerPill, {
      id: "waiting",
      show: () => {
        const now = shown()
        return now && pillView(now, ctx, {
          open: (url) => ctx.system.openExternal(url),
          refresh,
          more: () => void pick(),
        })
      },
    })
  },
})
