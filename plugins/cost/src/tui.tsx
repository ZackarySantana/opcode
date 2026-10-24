/** @jsxImportSource @opentui/solid */

import { errorMessage } from "@opcode/core"
import { ThemeSurface } from "@opcode/ui"
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, on } from "solid-js"
import { createCostService } from "./client.js"
import { CostDialog, PREFIX, type CostHost, type ImportState, type Timers } from "./dialog.js"
import { importProject } from "./importer.js"

const timers: Timers = {
  interval: (run) => { const id = setInterval(run, 5_000); return () => clearInterval(id) },
  timer: (run, ms) => { const id = setTimeout(run, ms); return () => clearTimeout(id) },
}

export const createCostTui = (timing: Timers = timers) => Plugin.define({
  id: PREFIX,
  setup(api) {
    const controller = new AbortController()
    const [revision, setRevision] = createSignal(0)
    const [imports, setImports] = createSignal<Record<string, ImportState>>({})
    const location = () => api.location ?? api.data.location.default()
    // Each location keeps its own import state; the dialog only shows the current location's.
    const importState = () => imports()[JSON.stringify(location())] ?? { type: "idle" }
    const tasks = new Set<Promise<void>>()
    let importing: { key: string; abort: AbortController; task: Promise<void> } | undefined
    /** One import at a time: a repeat for the same location joins it; another location cancels it. */
    const reconcile = () => {
      if (controller.signal.aborted) return Promise.resolve()
      const target = { ...location() }
      const key = JSON.stringify(target)
      if (importing?.key === key) return importing.task
      importing?.abort.abort()
      const abort = new AbortController()
      const signal = AbortSignal.any([controller.signal, abort.signal])
      const settle = (state: ImportState) => { if (!signal.aborted) setImports((all) => ({ ...all, [key]: state })) }
      settle({ type: "running" })
      const task: Promise<void> = importProject(api.client, createCostService(api.client, target), signal).then(
        () => settle({ type: "idle" }),
        (error: unknown) => settle({ type: "failed", message: errorMessage(error) }),
      ).finally(() => {
        tasks.delete(task)
        if (importing?.task === task) importing = undefined
        if (!signal.aborted) setRevision((value) => value + 1)
      })
      importing = { key, abort, task }
      tasks.add(task)
      return task
    }
    void reconcile()
    createEffect(on(location, () => { void reconcile() }, { defer: true }))
    const host: CostHost = {
      timers: timing, location, revision, importState,
      refresh() {
        if (controller.signal.aborted) return
        setRevision((value) => value + 1)
        void reconcile()
      },
    }
    let opened = false
    api.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: `${PREFIX}.open`, title: "Cost", description: "Open the server cost and token ledger", group: "Plugin", palette: true,
        slash: { name: "cost" },
        run() {
          if (controller.signal.aborted) return
          api.ui.dialog.show(() => <ThemeSurface name="dialog"><CostDialog host={host} /></ThemeSurface>, () => { opened = false })
          opened = true
          api.ui.dialog.set({ size: "large", centered: true })
        },
      }],
    }))
    return async () => {
      controller.abort()
      if (opened) api.ui.dialog.clear()
      await Promise.allSettled(tasks)
    }
  },
})

export default createCostTui()
