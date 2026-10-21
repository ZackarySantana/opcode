/** @jsxImportSource @opentui/solid */
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { SessionsView } from "../src/view"
import type { BrowserModel } from "../src/browser"

export function View(props: { api: Context; model: BrowserModel }) {
  return <PluginContextProvider value={props.api}><SessionsView model={props.model} currentSession={() => undefined} /></PluginContextProvider>
}
