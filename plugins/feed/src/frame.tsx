/** @jsxImportSource @opentui/solid */

import { KeyHints, type KeyHint } from "@opcode/ui"
import type { JSX } from "@opentui/solid/jsx-runtime"

/** Lines the key hints may wrap to; reserved on every tab so wrapping never changes the dialog's height. */
const HINT_LINES = 2

/** Every tab and the feed picker share one height: fixed content, then a fixed footer of key hints. */
export function TabFrame(props: { height: number; hints: readonly KeyHint[]; children: JSX.Element }) {
  return (
    <box flexDirection="column" minWidth={0}>
      <box height={props.height} flexDirection="column" minWidth={0} overflow="hidden">{props.children}</box>
      <box height={HINT_LINES + 1} paddingTop={1} minWidth={0} overflow="hidden"><KeyHints items={props.hints} /></box>
    </box>
  )
}
