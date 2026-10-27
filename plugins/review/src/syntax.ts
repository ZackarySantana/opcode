import type { Context } from "@opencode/plugin/tui/context"
import { generateSyntax } from "@opencode/theme/tui"
import type { SyntaxStyle } from "@opentui/core"
import { createMemo, onCleanup } from "solid-js"

/** The host theme's syntax colors for diffs, rebuilt when the theme changes. Call it inside the component that draws them. */
export function useSyntax(api: Pick<Context, "theme" | "renderer">): () => SyntaxStyle {
  // A style the renderer still draws is destroyed only once it is idle.
  const retire = (style: SyntaxStyle) => void api.renderer.idle().then(() => style.destroy())
  const style = createMemo<SyntaxStyle>((previous) => {
    if (previous) retire(previous)
    return generateSyntax(api.theme, api.renderer.nativeScene)
  })
  onCleanup(() => retire(style()))
  return style
}
