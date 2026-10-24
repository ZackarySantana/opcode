/** @jsxImportSource @opentui/solid */
import { ThemeSurface } from "@opcode/ui"
import { Plugin } from "@opencode/plugin/tui"
import { createBrowser } from "./browser"
import { SnippetsDialog } from "./dialog"
import { PLUGIN_ID } from "./domain"
import { snippetsRemote } from "./rpc"

export default Plugin.define({
  id: PLUGIN_ID,
  setup(api) {
    const location = api.location ?? api.data.location.default()
    const browser = createBrowser(api, snippetsRemote(api.client, location.directory),
      () => <ThemeSurface name="dialog"><SnippetsDialog browser={browser} /></ThemeSurface>)
    // The host keeps its `@` completion list until the collection is invalidated, even after skills reload.
    const unsubscribe = api.data.on("skill.updated", () => {
      api.data.location.skill.invalidate(location)
      void api.data.location.skill.sync(location).catch(() => {})
      if (browser.shown()) void browser.load()
    })
    api.keymap.layer(() => ({ mode: "global", commands: [{
      id: "opcode-snippets.open", title: "Snippets", description: "Insert, edit, or write reusable prompt snippets", group: "Plugin", palette: true,
      slash: { name: "snippets", arguments: true },
      run: (input) => browser.command(input),
    }] }))
    return () => {
      unsubscribe()
      browser.dispose()
    }
  },
})
