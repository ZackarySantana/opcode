/** @jsxImportSource @opentui/solid */

import { usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createContext, useContext } from "solid-js"

const SurfaceContext = createContext<() => Context["theme"]>()

/** Keep shared cards and hints on the same resolved surface as their dialog. */
export function ThemeSurface(props: { name: "dialog"; children: JSX.Element }) {
  const context = usePlugin()
  return <SurfaceContext.Provider value={() => context.theme.surface(props.name)}>{props.children}</SurfaceContext.Provider>
}

/** Hue steps follow the host's contrast direction in both light and dark mode.
 * Read lazily so changing themes also updates already-mounted views.
 * Action text can deliberately be neutral, so use the theme's hue aliases for
 * decorative accents and metrics, not its button-label colors.
 */
export function usePalette() {
  const context = usePlugin()
  const theme = useContext(SurfaceContext) ?? (() => context.theme)
  return {
    get text() { return theme().text.base },
    get muted() { return theme().text.muted },
    get accent() { return theme().hue.accent[300] },
    get value() { return theme().hue.interactive[300] },
    get border() { return theme().hue.accent[600] },
    get track() { return theme().border.base },
    get background() { return theme().background.base },
    get panel() { return theme().background.raised.base },
    get selectedText() { return theme().text.action.primary.selected },
    get selectedBackground() { return theme().background.action.primary.selected },
    get success() { return theme().text.feedback.success.base },
    get warning() { return theme().text.feedback.warning.base },
    get error() { return theme().text.feedback.error.base },
  }
}
