import { createRefresh, type RefreshState } from "@opcode/core/refresh"
import { Command, createKeyed, Plugin, Style, TitlebarItem, type DialogHandle } from "@opencode/plugin/gui"
import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { createCostService, described } from "./client.js"
import type { Dashboard } from "./domain.js"
import { CostDialog } from "./gui/dialog.js"
import { en } from "./gui/i18n.js"
import { css } from "./gui/style.js"
import { spendLabel } from "./gui/view.js"
import { CostRpc } from "./rpc.js"

/** Server events cover new usage; the poll covers a new day and events missed while disconnected. */
const POLL_MILLISECONDS = 60_000

export default Plugin.define({
  i18n: { en },
  setup(ctx) {
    // Bumped by the server's throttled `updated` event and by the poll; every open view rereads on it.
    const [revision, setRevision] = createSignal(0)
    const bump = () => { setRevision((value) => value + 1) }
    const [today, setToday] = createSignal<RefreshState<Dashboard>>({ loading: true })
    const refresh = createRefresh((signal) => described(createCostService(ctx.client).dashboard("today", signal)), setToday, { delay: 250 })
    createEffect(on(revision, () => refresh.schedule(), { defer: true }))
    // A restarted server comes back with a new client: subscribe again, and reread at once.
    createKeyed(() => ctx.client, (client) => {
      void refresh.refresh()
      onCleanup(client.rpc(CostRpc).events.on("updated", bump))
    })
    const poll = setInterval(bump, POLL_MILLISECONDS)

    let dialog: DialogHandle | undefined
    const open = () => {
      if (dialog) return
      const handle = ctx.dialogs.open((current) => {
        onCleanup(() => { if (dialog === handle) dialog = undefined })
        return <CostDialog ctx={ctx} revision={revision} close={current.close} />
      })
      dialog = handle
    }

    ctx.add(Style, css)
    ctx.add(Command, () => ({
      id: "open",
      title: ctx.t("command.open"),
      description: ctx.t("command.description"),
      keywords: "cost tokens usage spend time",
      slash: { name: "cost" },
      run: open,
    }))
    // Shown once today's figure has loaded; a failed refresh keeps the last one.
    ctx.add(TitlebarItem, (): TitlebarItem | undefined => {
      const value = today().value
      if (!value) return undefined
      const text = spendLabel(value)
      const label = ctx.t(text.key, text.params)
      return { id: "today", label, title: ctx.t("titlebar.title", { label }), icon: "window-analytics", run: open }
    })
    return () => {
      clearInterval(poll)
      refresh.dispose()
    }
  },
})
