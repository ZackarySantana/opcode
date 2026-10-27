/** @jsxImportSource @opentui/solid */

import { expect, test } from "bun:test"
import { mockTheme } from "@opcode/ui/test-support/host"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { Inbox, InboxRow } from "../src/inbox-host"
import { InboxSidebar } from "../src/sidebar"

const row = (id: string, state: InboxRow["state"], agents = 0): InboxRow => ({ id, state, read: false, agents, since: Date.now() - 200_000, title: `Title ${id}`, directory: `/work/${id}` })

test("rows are numbered in order; clicking one opens it, the back row goes back, and +N more opens /go", async () => {
  const opened: string[] = []
  const commands: string[] = []
  let wentBack = 0
  const [back, setBack] = createSignal<{ id: string; title: string }>()
  const inbox = {
    rows: () => [row("a", "working", 2), row("b", "needs-you"), row("c", "finished")],
    error: () => undefined, back,
    open: (id: string) => { opened.push(id); setBack({ id: "a", title: "Title a" }) },
    goBack: () => { wentBack++; setBack(undefined); return true },
  } as unknown as Inbox
  const host = { theme: mockTheme(), keymap: { dispatch: (id: string) => commands.push(id) } } as unknown as Context
  const view = await testRender(() => <PluginContextProvider value={host}><InboxSidebar inbox={inbox} limit={2} command="go" pointer="/go" /></PluginContextProvider>, { width: 48, height: 20 })
  const click = async (text: string) => {
    const lines = (await view.waitForFrame((frame) => frame.includes(text))).split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    await view.mockMouse.click(lines[y]!.indexOf(text), y)
  }
  try {
    const frame = await view.waitForFrame((frame) => frame.includes("+1 more"))
    expect(frame).toContain("1 ○ working · a · 2 agents")
    expect(frame).toContain("2 ● needs you · b")
    expect(frame).toContain("3m")
    expect(frame).not.toContain("Title c")
    expect(frame).not.toContain("Back to")
    await click("Title b")
    expect(opened).toEqual(["b"])
    await click("Back to Title a")
    expect(wentBack).toBe(1)
    // The back row's removal moves the lines below it.
    await view.waitForFrame((frame) => !frame.includes("Back to"))
    await click("/go")
    expect(commands).toEqual(["go"])
  } finally { await view.dispose() }
})
