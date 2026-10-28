/** @jsxImportSource @opentui/solid */

import { afterEach, expect, test } from "bun:test"
import { mockTheme } from "@opcode/ui/test-support/host"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, KeymapCommand, KeymapLayer } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { createComputed, onCleanup } from "solid-js"
import { PullRequestsClient } from "../src/client"
import { PullRequestsDialog } from "../src/dialog"
import { defaultSettings } from "../src/model"
import { closeServers, eventually, fakeServer, ghRunner, stopped } from "./host"

afterEach(closeServers)

test("/ghpr pages through your pull requests, your reviews, and your teams', and saves its settings and the team filter", async () => {
  const server = fakeServer({ run: ghRunner().run })
  const prs = new PullRequestsClient(server.remote(), stopped)
  // Layers leave with their owner, as in the host, so a stale command from an unmounted tab or picker can't run.
  const layers = new Set<() => KeymapLayer>()
  const dispatch = (id: string) => [...layers].map((layer) => layer()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .flatMap((layer) => (layer.commands ?? []) as KeymapCommand[])
    .find((command) => command.id === id && (typeof command.enabled === "function" ? command.enabled() : command.enabled ?? true))?.run()
  let cleared = false
  const host = {
    theme: mockTheme(),
    renderer: { widthMethod: "unicode", once() {}, off() {}, requestRender() {} },
    ui: { dialog: { clear: () => { cleared = true } }, toast: { show() {} } },
    keymap: {
      dispatch,
      layer: (factory: () => KeymapLayer) => {
        let current: KeymapLayer = {}
        const layer = () => current
        createComputed(() => { current = factory() })
        layers.add(layer)
        onCleanup(() => layers.delete(layer))
      },
    },
  } as unknown as Context
  prs.start()
  const view = await testRender(() => <PluginContextProvider value={host}><PullRequestsDialog prs={prs} /></PluginContextProvider>, { width: 110, height: 44 })
  const frame = async (text: string) => view.waitForFrame((frame) => frame.includes(text))
  try {
    expect(await frame("NEEDS YOU")).toMatch(/NEEDS YOU[\s\S]*WAITING[\s\S]*DRAFTS/)

    dispatch("opcode-gh-pr-status.next")
    const reviewing = await frame("AWAITING YOUR REVIEW")
    expect(reviewing).toMatch(/Review requested\s+@alice[\s\S]*Requested: you \(2h ago\)[\s\S]*REVIEWED BY YOU/)
    expect(reviewing).toContain("! 1 pull request hidden: authorize GitHub CLI")
    // By default, a month without activity leaves a pull request out, until Ignore inactive is off.
    expect(reviewing).not.toContain("Retire the v1 API")
    dispatch("opcode-gh-pr-status.previous")
    dispatch("opcode-gh-pr-status.previous")
    await frame("Ignore inactive")
    dispatch("opcode-gh-pr-status.down")
    for (let step = 0; step < 3; step++) dispatch("opcode-gh-pr-status.adjust.previous")
    dispatch("opcode-gh-pr-status.next")
    dispatch("opcode-gh-pr-status.next")
    expect(await frame("Retire the v1 API")).toContain("REVIEWED BY YOU")

    dispatch("opcode-gh-pr-status.next")
    expect(await frame("AWAITING REVIEW")).toContain("New billing API")

    // In the picker, esc leaves the box, clears the search, then closes the picker, never the dialog.
    dispatch("opcode-gh-pr-status.pick")
    await frame("All your teams")
    dispatch("opcode-gh-pr-status.search")
    await view.mockInput.typeText("api")
    await view.waitForFrame((frame) => frame.includes("acme/api") && !frame.includes("acme/web"))
    for (let step = 0; step < 3; step++) dispatch("opcode-gh-pr-status.close")
    await frame("AWAITING REVIEW")
    expect(cleared).toBe(false)

    dispatch("opcode-gh-pr-status.pick")
    await frame("All your teams")
    dispatch("opcode-gh-pr-status.down")
    dispatch("opcode-gh-pr-status.down")
    dispatch("opcode-gh-pr-status.activate")
    const web = await frame("acme/web ›")
    expect(web).toContain("Speed up CI")
    expect(web).not.toContain("New billing API")
    // Saved on the server, for every terminal.
    await eventually(() => expect(server.stored.get("settings")).toEqual({ ...defaultSettings, ignoreDays: 0, team: "acme/web" }))

    // The saved filter isn't a step back: esc closes the dialog.
    dispatch("opcode-gh-pr-status.close")
    expect(cleared).toBe(true)
  } finally {
    await view.dispose()
    prs.dispose()
  }
})
