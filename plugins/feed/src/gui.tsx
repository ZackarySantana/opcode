import { Command, Plugin, Style, TitlebarItem, type DialogHandle } from "@opencode/plugin/gui"
import { onCleanup } from "solid-js"
import { createRemote, FeedsClient } from "./client"
import { feedActions } from "./gui/actions"
import { FeedDialog } from "./gui/dialog"
import { en } from "./gui/i18n"
import { css } from "./gui/style"

/** Feeds in the desktop app: the server part fetches them; a titlebar pill counts in-progress incidents. */
export default Plugin.define({
  i18n: { en },
  setup(ctx) {
    // The feeds are the same in every location: calls go to the routed session's directory, or on Home, where there is
    // none, to the app's server's default location, so the titlebar pill works before any session opens.
    const feeds = new FeedsClient(createRemote(() => ctx.client, () => {
      const directory = ctx.sessions.current()?.directory
      return directory ? { directory } : undefined
    }))
    const actions = feedActions({
      t: ctx.t,
      plural: ctx.plural,
      select: (options) => ctx.dialogs.select(options),
      prompt: (options) => ctx.dialogs.prompt(options),
      confirm: (options) => ctx.dialogs.confirm(options),
      toast: (options) => { ctx.toast.show(options) },
      feeds,
    })

    let dialog: DialogHandle | undefined
    const open = () => {
      if (dialog) return
      const handle = ctx.dialogs.open(() => {
        onCleanup(() => { if (dialog === handle) dialog = undefined })
        return <FeedDialog feeds={feeds} actions={actions} />
      })
      dialog = handle
    }

    ctx.add(Style, css)
    ctx.add(TitlebarItem, (): TitlebarItem | undefined => {
      const count = feeds.timeline("feed").current.length
      return count ? { id: "incidents", label: ctx.plural("incidents", count), title: ctx.t("incidents.title"), icon: "warning", run: open } : undefined
    })
    ctx.add(Command, (): Command => ({
      id: "open",
      title: ctx.t("command.open"),
      description: ctx.t("command.open.description"),
      slash: { name: "feed" },
      run: open,
    }))
    ctx.add(Command, (): Command => ({
      id: "refresh-all",
      title: ctx.t("command.refresh"),
      description: ctx.t("command.refresh.description"),
      slash: { name: "feed-refresh" },
      run: () => actions.refresh(),
    }))
    feeds.start()
    return () => feeds.dispose()
  },
})
