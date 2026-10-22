/** @jsxImportSource @opentui/solid */

import { expect, test } from "bun:test"
import { mockTheme } from "@opcode/ui/test-support/host"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, KeymapCommand, KeymapLayer } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { createComputed } from "solid-js"
import type { Runner } from "../src/gh"
import { PullRequestsDialog } from "../src/dialog"
import { PullRequestsController } from "../src/host"
import { SettingsDatabase } from "../src/sqlite"
import { response, teams } from "./fixtures"

const runner: Runner = async (args) => ({ stdout: args.includes("graphql") ? response : teams, stderr: "", status: 0 })

test("/ghpr pages through your pull requests, your reviews, and your teams', and saves the team filter", async () => {
  const database = new SettingsDatabase(":memory:")
  const prs = new PullRequestsController(database, runner)
  const layers: (() => KeymapLayer)[] = []
  const dispatch = (id: string) => layers.map((layer) => layer()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .flatMap((layer) => (layer.commands ?? []) as KeymapCommand[]).find((command) => command.id === id && (typeof command.enabled === "function" ? command.enabled() : command.enabled ?? true))?.run()
  let cleared = false
  const host = {
    theme: mockTheme(),
    renderer: { widthMethod: "unicode", once() {}, off() {}, requestRender() {} },
    ui: { dialog: { clear: () => { cleared = true } }, toast: { show() {} } },
    keymap: { dispatch, layer: (factory: () => KeymapLayer) => { let current: KeymapLayer = {}; createComputed(() => { current = factory() }); layers.push(() => current) } },
  } as unknown as Context
  prs.refresh()
  const view = await testRender(() => <PluginContextProvider value={host}><PullRequestsDialog prs={prs} /></PluginContextProvider>, { width: 110, height: 44 })
  const frame = async (text: string) => view.waitForFrame((frame) => frame.includes(text))
  try {
    const mine = await frame("NEEDS YOU")
    // Conflicts outrank failing checks; approval waits on you to merge; a draft waits in its own group.
    expect(mine).toMatch(/Conflicts\s+acme\/web#1/)
    expect(mine).toContain("Approved")
    expect(mine).toMatch(/WAITING[\s\S]*Upgrade TypeScript[\s\S]*Requested: @alice[\s\S]*DRAFTS[\s\S]*Refactor the router/)

    dispatch("opcode-gh-pr-status.next")
    const reviewing = await frame("AWAITING YOUR REVIEW")
    expect(reviewing).toMatch(/Your review\s+@alice · acme\/web#10[\s\S]*opened 3d ago · requested 2h ago/)
    expect(reviewing).toMatch(/REVIEWED BY YOU[\s\S]*You approved\s+@erin/)
    expect(reviewing).not.toContain("You commented")
    expect(reviewing).toContain("! 1 hidden by GitHub: Resource protected by organization SAML enforcement.")

    dispatch("opcode-gh-pr-status.next")
    const all = await frame("AWAITING YOUR TEAMS")
    for (const title of ["Cache build artifacts", "Speed up CI", "New billing API", "Rotate secrets"]) expect(all).toContain(title)
    expect(all).toContain("Requested: 1 hidden")

    dispatch("opcode-gh-pr-status.pick")
    await frame("All your teams")
    expect(await frame("hidden team")).toMatch(/acme\/api\s+1 awaiting review[\s\S]*acme\/web\s+2 awaiting review/)
    dispatch("opcode-gh-pr-status.down")
    dispatch("opcode-gh-pr-status.down")
    dispatch("opcode-gh-pr-status.activate")
    const web = await frame("AWAITING ACME/WEB")
    expect(web).toContain("acme/web › ")
    expect(web).toContain("Speed up CI")
    expect(web).not.toContain("New billing API")
    expect(database.settings().team).toBe("acme/web")

    // The saved filter isn't a step back: esc closes the dialog.
    dispatch("opcode-gh-pr-status.close")
    expect(cleared).toBe(true)
  } finally {
    await view.dispose()
    prs.dispose()
    database.close()
  }
})
