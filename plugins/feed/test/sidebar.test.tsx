/** @jsxImportSource @opentui/solid */

import { afterEach, expect, test } from "bun:test"
import { closeServers, eventually, fakeServer, stopped } from "@opcode/core/test-support/server"
import { mockTheme } from "@opcode/ui/test-support/host"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { MouseButton } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { FeedsClient, type Remote } from "../src/client"
import { serverPlugin } from "../src/index"
import { Sidebar } from "../src/sidebar"
import { remote } from "./host"

afterEach(closeServers)

const item = (title: string, status: string, hoursAgo: number, link?: string) => `<item><title>${title}</title><guid>${title}</guid>
  <description>&lt;p&gt;&lt;strong&gt;${status}&lt;/strong&gt; - details&lt;/p&gt;</description>
  <pubDate>${new Date(Date.now() - hoursAgo * 3_600_000).toUTCString()}</pubDate>${link ? `<link>${link}</link>` : ""}</item>`
// Six incidents overflow the sidebar's five; an ftp link is refused before any browser is launched.
const rss = `<rss><channel><title>npm</title>
  ${item("Outage 1", "Identified", 1, "ftp://status.test/1")}${[2, 3, 4, 5, 6].map((n) => item(`Outage ${n}`, "Identified", n)).join("")}
  ${item("Planned work", "Scheduled", -3)}
</channel></rss>`

async function mount(xml: string, to?: Remote) {
  const feeds = new FeedsClient(to ?? remote(fakeServer({ plugin: serverPlugin(async () => xml, { timer: stopped }) })), stopped)
  feeds.start()
  const toasts: { message: string; variant: string }[] = []
  const commands: string[] = []
  const host = {
    theme: mockTheme(),
    ui: { toast: { show: (toast: { message: string; variant: string }) => toasts.push({ message: toast.message, variant: toast.variant }) } },
    keymap: { dispatch: (id: string) => commands.push(id) },
  } as unknown as Context
  const view = await testRender(() => <PluginContextProvider value={host}><Sidebar feeds={feeds} /></PluginContextProvider>, { width: 48, height: 30 })
  const dispose = async () => { await view.dispose(); feeds.dispose() }
  return { feeds, view, toasts, commands, dispose }
}

test("clicking a sidebar item opens its link like enter in /feed, and the /feed pointer opens the dialog", async () => {
  const { feeds, view, toasts, commands, dispose } = await mount(rss)
  const click = async (text: string, button?: MouseButton) => {
    const lines = (await view.waitForFrame((frame) => frame.includes(text))).split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    await view.mockMouse.click(lines[y]!.indexOf(text), y, button)
  }
  try {
    feeds.subscribe("https://npm.test/rss", "status")
    await eventually(() => expect(feeds.results().get("https://npm.test/rss")?.status).toBe("ok"))
    await click("Outage 1", 2)
    expect(toasts).toEqual([])
    await click("Outage 1")
    await click("maintenance scheduled")
    expect(toasts).toEqual([
      { message: "Refusing to open ftp://status.test/1", variant: "error" },
      { message: "This item has no link.", variant: "warning" },
    ])
    await click("/feed")
    expect(commands).toEqual(["opcode-feed.open"])
  } finally {
    await dispose()
  }
})

test("the refresh button beside the title fetches every feed again", async () => {
  let fetches = 0
  const { feeds, view, dispose } = await mount("", remote(fakeServer({ plugin: serverPlugin(async () => { fetches++; return rss }, { timer: stopped }) })))
  try {
    feeds.subscribe("https://npm.test/rss", "status")
    await eventually(() => expect(feeds.results().get("https://npm.test/rss")?.status).toBe("ok"))
    const before = fetches
    const lines = (await view.waitForFrame((frame) => frame.includes("↻"))).split("\n")
    const y = lines.findIndex((line) => line.includes("↻"))
    expect(lines[y]).toContain("Feeds")
    await view.mockMouse.click(lines[y]!.indexOf("↻"), y)
    await eventually(() => expect(fetches).toBe(before + 1))
  } finally {
    await dispose()
  }
})

test("operational status pages stay out of the sidebar", async () => {
  const { feeds, view, dispose } = await mount("<rss><channel><title>Quiet</title></channel></rss>")
  try {
    feeds.subscribe("https://quiet.test/rss", "status")
    await eventually(() => expect(feeds.results().get("https://quiet.test/rss")?.status).toBe("ok"))
    expect(feeds.timeline("sidebar").pending).toBe(0)
    await view.flush()
    // Once fetched, the quiet page isn't listed: the section is just its title.
    const frame = view.captureCharFrame()
    expect(frame).toContain("Feeds")
    expect(frame).not.toContain("Quiet")
  } finally {
    await dispose()
  }
})

test("the sidebar says what to do when the server doesn't run the plugin", async () => {
  const unavailable = async () => { throw { type: "rpc.unavailable", message: "no" } }
  const { view, dispose } = await mount("", {
    state: unavailable, update: unavailable, subscribe: unavailable, unsubscribe: unavailable, refresh: unavailable,
    changes: () => ({ async *[Symbol.asyncIterator]() {} }),
  })
  try {
    const frame = await view.waitForFrame((frame) => frame.includes("add"))
    expect(frame).toContain("Feeds")
    expect(frame.replace(/\s+/g, " ")).toContain("isn't running Feed: add @lidtop/opencode-feed to the server's plugins.")
  } finally {
    await dispose()
  }
})
