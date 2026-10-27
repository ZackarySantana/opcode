/** @jsxImportSource @opentui/solid */

import { expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import { testRender, useRenderer } from "@opentui/solid"
import type { JSX } from "solid-js"
import plugin from "../src/tui"
import { fakeHost, fakePanel, SESSION, settle } from "./host"

/** The plugin as the host loads it, with its sidebar and session panel slots rendered. */
async function setup() {
  const host = fakeHost({ diff: () => [{ file: "src/auth.ts", patch: "@@ -1,1 +1,1 @@\n-a\n+b\n", additions: 1, deletions: 1, status: "modified" }] })
  const panel = fakePanel()
  let cleanup: (() => void) | void
  const slot = (path: string) => host.slots.find((entry) => Object.values(entry.claim).includes(path))!.render
  const view = await testRender(() => {
    // The syntax colors are a native resource of the renderer that draws them.
    Object.assign(host.api, { renderer: useRenderer() })
    cleanup = plugin.setup(host.api) as (() => void) | void
    return (
      <PluginContextProvider value={host.api}>
        <box flexDirection="column">
          {slot("sidebar.content")({ sessionID: SESSION } as never) as JSX.Element}
          {slot("session.panel")(panel.input as never) as JSX.Element}
        </box>
      </PluginContextProvider>
    )
  }, { width: 90, height: 30 })
  const run = async (...ids: string[]) => { for (const id of ids) { host.dispatch(`opcode-review.${id}`); await settle() } }
  return { ...host, panel, view, run, frame: (text: string) => view.waitForFrame((current) => current.includes(text)), dispose: async () => { cleanup?.(); await view.dispose() } }
}

test("/review opens the panel in a session, takes input when it's already open, and explains itself elsewhere", async () => {
  const { api, run, panelOpen, panel, toasts, session, frame, dispose } = await setup()
  try {
    await frame("Review This turn")
    await run("open")
    expect(panelOpen()).toEqual({ name: "opcode-review", sessionID: SESSION })
    const focused = panel.state.focusCount
    await run("open")
    expect(panel.state.focusCount).toBe(focused + 1)

    api.ui.panel.close()
    session.open = false
    await run("open")
    expect(toasts.at(-1)).toMatchObject({ variant: "warning", message: expect.stringContaining("Open a session first") })
  } finally { await dispose() }
})

test("the sidebar counts what is left to send, what waits for the agent, and then that all was sent", async () => {
  const { run, view, frame, prompts, setPending, dispose } = await setup()
  try {
    await frame("Review This turn")
    expect(view.captureCharFrame()).not.toContain("to send")
    await run("down", "comment")
    await view.mockInput.typeText("Rename it")
    view.mockInput.pressEnter()
    await frame("1 to send")

    await run("send")
    setPending([prompts[0]!.id!])
    await frame("1 waiting")
    setPending([])
    await frame("all sent")
  } finally { await dispose() }
})
