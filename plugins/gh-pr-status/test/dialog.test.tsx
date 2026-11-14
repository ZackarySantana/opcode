/** @jsxImportSource @opentui/solid */

import { afterEach, expect, test } from "bun:test"
import { closeServers, eventually, fakeServer, stopped } from "@opcode/core/test-support/server"
import { mockTheme } from "@opcode/ui/test-support/host"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, KeymapCommand, KeymapLayer } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { createComputed, onCleanup } from "solid-js"
import { PullRequestsClient } from "../src/client"
import { PullRequestsDialog } from "../src/dialog"
import { serverPlugin } from "../src/index"
import { defaultSettings, type Settings } from "../src/model"
import { pr, team, user } from "./fixtures"
import { ghRunner, remote } from "./host"

afterEach(closeServers)

/** /ghpr on a fake server whose gh answers with `searched`, with the host's keymap and dialog. */
async function mount(searched?: string, size = { width: 110, height: 44 }) {
  const server = fakeServer({ plugin: serverPlugin(ghRunner(searched).run, stopped) })
  const prs = new PullRequestsClient(remote(server), stopped)
  // Layers leave with their owner, as in the host, so a stale command from an unmounted tab or picker can't run.
  const layers = new Set<() => KeymapLayer>()
  const dispatch = (id: string) => [...layers].map((layer) => layer()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .flatMap((layer) => (layer.commands ?? []) as KeymapCommand[])
    .find((command) => command.id === `opcode-gh-pr-status.${id}` && (typeof command.enabled === "function" ? command.enabled() : command.enabled ?? true))?.run()
  const closed = { cleared: false }
  const host = {
    theme: mockTheme(),
    renderer: { widthMethod: "unicode", once() {}, off() {}, requestRender() {} },
    ui: { dialog: { clear: () => { closed.cleared = true } }, toast: { show() {} } },
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
  const view = await testRender(() => <PluginContextProvider value={host}><PullRequestsDialog prs={prs} /></PluginContextProvider>, size)
  const frame = async (text: string) => view.waitForFrame((frame) => frame.includes(text))
  return { server, view, dispatch, frame, closed, dispose: async () => { await view.dispose(); prs.dispose() } }
}

test("/ghpr pages through your pull requests, your reviews, and your teams', and saves its settings and the team filter", async () => {
  const { server, view, dispatch, frame, closed, dispose } = await mount()
  try {
    expect(await frame("NEEDS YOU")).toMatch(/NEEDS YOU[\s\S]*WAITING[\s\S]*DRAFTS/)

    dispatch("next")
    const reviewing = await frame("AWAITING YOUR REVIEW")
    expect(reviewing).toMatch(/Review requested\s+@alice[\s\S]*Requested: you \(2h ago\)[\s\S]*REVIEWED BY YOU/)
    expect(reviewing).toContain("! 1 pull request hidden: authorize GitHub CLI")
    // By default, a month without activity leaves a pull request out, until Ignore inactive is off.
    expect(reviewing).not.toContain("Retire the v1 API")
    dispatch("previous")
    dispatch("previous")
    await frame("Ignore inactive")
    dispatch("down")
    for (let step = 0; step < 3; step++) dispatch("adjust.previous")
    dispatch("next")
    dispatch("next")
    expect(await frame("Retire the v1 API")).toContain("REVIEWED BY YOU")

    dispatch("next")
    expect(await frame("AWAITING REVIEW")).toContain("New billing API")

    // In the picker, esc leaves the box, clears the search, then closes the picker, never the dialog.
    dispatch("pick")
    await frame("All your teams")
    dispatch("search")
    await view.mockInput.typeText("api")
    await view.waitForFrame((frame) => frame.includes("acme/api") && !frame.includes("acme/web"))
    for (let step = 0; step < 3; step++) dispatch("close")
    await frame("AWAITING REVIEW")
    expect(closed.cleared).toBe(false)

    dispatch("pick")
    await frame("All your teams")
    dispatch("down")
    dispatch("down")
    dispatch("activate")
    const web = await frame("acme/web ›")
    expect(web).toContain("Speed up CI")
    expect(web).not.toContain("New billing API")
    // Saved on the server, for every terminal.
    await eventually(() => expect(server.stored.get("settings")).toEqual({ ...defaultSettings, ignoreDays: 0, team: "acme/web" }))

    // The saved filter isn't a step back: esc closes the dialog.
    dispatch("close")
    expect(closed.cleared).toBe(true)
  } finally {
    await dispose()
  }
})

test("Orgs lists every org with pull requests to choose from, and hides the chosen orgs' or shows only theirs, saved", async () => {
  const searched = JSON.stringify({ data: {
    viewer: { login: "me" },
    mine: { nodes: [pr(1, "Fix login redirect")] },
    requested: { nodes: [
      pr(10, "Cache build artifacts", { author: "alice", repo: "acme/api", requested: [{ reviewer: user("me"), hours: 2 }] }),
      pr(11, "Speed up CI", { author: "bob", repo: "Globex/infra", requested: [{ reviewer: team("acme/web"), hours: 5 }] }),
    ] },
    reviewed: { nodes: [] },
  } })
  const { server, view, dispatch, frame, dispose } = await mount(searched)
  const saved = () => {
    const scope = (server.stored.get("settings") as Settings | undefined)?.scope
    return scope && { mode: scope.mode, orgs: new Set(scope.orgs) }
  }
  try {
    await frame("Fix login redirect")
    // Just before Settings.
    dispatch("previous")
    dispatch("previous")
    const orgs = await frame("Globex")
    expect(orgs).toMatch(/\[ \] acme\s+2 pull requests[\s\S]*\[ \] Globex\s+1 pull request/)
    expect(orgs).toContain("Nothing chosen")

    // The box narrows the choices; enter in it chooses the outlined one.
    dispatch("search")
    await view.mockInput.typeText("glob")
    await view.waitForFrame((frame) => frame.includes("Globex") && !frame.includes("acme"))
    view.mockInput.pressEnter()
    expect(await frame("[x] Globex")).toMatch(/\[Exclude\][\s\S]*2 of 3 pull requests/)
    await view.mockInput.typeText("zzz")
    await frame("No matching orgs.")
    dispatch("close")
    dispatch("close")

    // A click chooses too.
    const lines = (await frame("[ ] acme")).split("\n")
    const y = lines.findIndex((line) => line.includes("[ ] acme"))
    await view.mockMouse.click(lines[y]!.indexOf("acme"), y)
    expect(await frame("[x] acme")).toContain("0 of 3")
    await eventually(() => expect(saved()).toEqual({ mode: "exclude", orgs: new Set(["acme", "Globex"]) }))

    // The mode keeps what was chosen, and stops at either end.
    dispatch("adjust.next")
    expect(await frame("[Include]")).toContain("3 of 3")
    dispatch("adjust.next")
    // The click outlined acme.
    dispatch("activate")
    expect(await frame("1 of 3")).toContain("[ ] acme")
    await eventually(() => expect(saved()).toEqual({ mode: "include", orgs: new Set(["Globex"]) }))

    // The other tabs list only what's in scope, and say how much the scope hides.
    dispatch("previous")
    const teams = await frame("AWAITING REVIEW")
    expect(teams).toContain("Speed up CI")
    expect(teams).toContain("2 pull requests hidden by the Orgs tab")
    dispatch("previous")
    dispatch("previous")
    const mine = await frame("Nothing here.")
    expect(mine).not.toContain("Fix login redirect")
  } finally {
    await dispose()
  }
})

test("Orgs scrolls a long list to the outlined org, keeping the mode in view", async () => {
  const names = Array.from({ length: 30 }, (_, index) => `org-${String(index + 1).padStart(2, "0")}`)
  const searched = JSON.stringify({ data: {
    viewer: { login: "me" },
    mine: { nodes: names.map((org, index) => pr(index + 1, `Change ${index + 1}`, { repo: `${org}/app` })) },
    requested: { nodes: [] },
    reviewed: { nodes: [] },
  } })
  const { dispatch, frame, dispose } = await mount(searched, { width: 110, height: 30 })
  try {
    await frame("Change 1")
    dispatch("previous")
    dispatch("previous")
    expect(await frame("org-01")).not.toContain("org-30")
    for (let step = 0; step < 40; step++) dispatch("down")
    const end = await frame("org-30")
    expect(end).toContain("Mode")
    expect(end).not.toContain("org-01")
  } finally {
    await dispose()
  }
})
