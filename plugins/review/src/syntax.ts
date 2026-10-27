import type { Context } from "@opencode/plugin/tui/context"
import { generateSyntax } from "@opencode/theme/tui"
import type { SyntaxStyle } from "@opentui/core"
import { createMemo, onCleanup } from "solid-js"
import { MARK_STYLE } from "./segment"

/** The host theme's syntax colors for diffs, rebuilt when the theme changes. Call it inside the component that draws them. */
export function useSyntax(api: Pick<Context, "theme" | "renderer">): () => SyntaxStyle {
  // A style the renderer still draws is destroyed only once it is idle.
  const retire = (style: SyntaxStyle) => void api.renderer.idle().then(() => style.destroy())
  const style = createMemo<SyntaxStyle>((previous) => {
    if (previous) retire(previous)
    const style = generateSyntax(api.theme, api.renderer.nativeScene)
    // The picked name in the selection's colors; its other uses underlined on the brightest raised surface.
    style.registerStyle(MARK_STYLE.token, { fg: api.theme.text.action.primary.selected, bg: api.theme.background.action.primary.selected, bold: true })
    style.registerStyle(MARK_STYLE.word, { bg: api.theme.background.raised.max, underline: true })
    return style
  })
  onCleanup(() => retire(style()))
  return style
}
