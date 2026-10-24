/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createBrowser, LIST_ROUTE } from "./browser"
import { PLUGIN_ID } from "./domain"
import { snippetsRemote } from "./rpc"
import { SnippetsView } from "./view"

export default Plugin.define({
  id: PLUGIN_ID,
  setup(api) {
    const location = api.location ?? api.data.location.default()
    const browser = createBrowser(api, snippetsRemote(api.client, location.directory))
    const unregister = api.ui.router.register({ name: LIST_ROUTE, render: () => <SnippetsView browser={browser} /> })
    // The host keeps its `@` completion list until the collection is invalidated, even after skills reload.
    const unsubscribe = api.data.on("skill.updated", () => {
      api.data.location.skill.invalidate(location)
      void api.data.location.skill.sync(location).catch(() => {})
      if (browser.screen.active()) void browser.load()
    })
    const active = () => browser.screen.active()
    api.keymap.layer(() => ({ mode: "global", commands: [{
      id: "opcode-snippets.open", title: "Snippets", description: "Insert, edit, or write reusable prompt snippets", group: "Plugin", palette: true,
      slash: { name: "snippets", arguments: true },
      run: (input) => browser.command(input),
    }] }))
    browser.screen.commands(() => [
      { id: "opcode-snippets.close", title: "Back", bind: "escape", run() { if (active()) browser.screen.close() } },
      { id: "opcode-snippets.up", title: "Previous snippet", bind: "up,k", run() { if (active()) browser.move(-1) } },
      { id: "opcode-snippets.down", title: "Next snippet", bind: "down,j", run() { if (active()) browser.move(1) } },
      { id: "opcode-snippets.insert", title: "Insert #name into the prompt", bind: "return", run: async () => { if (active()) await browser.insert() } },
      { id: "opcode-snippets.new", title: "Write a new snippet in chat", bind: "n", run: async () => { if (active()) await browser.author({}) } },
      { id: "opcode-snippets.edit", title: "Edit snippet in chat", bind: "e", run: async () => { if (active()) await browser.edit() } },
      { id: "opcode-snippets.delete", title: "Delete snippet", bind: "d", run: async () => { if (active()) await browser.remove() } },
      { id: "opcode-snippets.refresh", title: "Refresh", bind: "r", run: async () => { if (active()) await browser.load() } },
    ])
    return () => {
      unsubscribe()
      browser.dispose()
      unregister()
    }
  },
})
