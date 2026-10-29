/** @jsxImportSource @opentui/solid */

import { afterEach, expect, test } from "bun:test"
import { closeServers, eventually, fakeServer, stopped } from "@opcode/core/test-support/server"
import { mockTheme } from "@opcode/ui/test-support/host"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { PullRequestsClient } from "../src/client"
import { serverPlugin } from "../src/index"
import { Sidebar } from "../src/sidebar"
import { ghRunner, remote } from "./host"

afterEach(closeServers)

test("the refresh button at the end of the title line searches pull requests again", async () => {
  const gh = ghRunner()
  const prs = new PullRequestsClient(remote(fakeServer({ plugin: serverPlugin(gh.run, stopped) })), stopped)
  prs.start()
  const host = { theme: mockTheme(), keymap: { dispatch() {} } } as unknown as Context
  const view = await testRender(() => <PluginContextProvider value={host}><Sidebar prs={prs} /></PluginContextProvider>, { width: 48, height: 30 })
  try {
    // The first search has finished once its pull requests are listed.
    const lines = (await view.waitForFrame((frame) => frame.includes("↻") && /[#@]/.test(frame))).split("\n")
    const before = gh.searches.length
    const y = lines.findIndex((line) => line.includes("↻"))
    expect(lines[y]).toContain("Pull requests")
    await view.mockMouse.click(lines[y]!.indexOf("↻"), y)
    await eventually(() => expect(gh.searches.length).toBeGreaterThan(before))
  } finally {
    await view.dispose()
    prs.dispose()
  }
})
