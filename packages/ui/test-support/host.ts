import type { Context } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { usePalette } from "../src/palette"

export type ThemeColors = Record<keyof ReturnType<typeof usePalette>, RGBA | string>

const defaults: Omit<ThemeColors, "track"> = {
  text: "#e0e1e2", muted: "#819293", accent: "#77cccc", value: "#88aaff", border: "#617273",
  background: "#101112", panel: "#242526", selectedText: "#171717", selectedBackground: "#ffaf87",
  success: "#77cc88", warning: "#eecc66", error: "#ee6666",
}

/** Every theme token the shared palette reads, keyed by palette name. The surface resolves to itself. */
export function mockTheme(colors: Partial<Omit<ThemeColors, "track">> = {}): Context["theme"] {
  const c = Object.fromEntries(Object.entries({ ...defaults, ...colors }).map(([key, value]) => [key, typeof value === "string" ? RGBA.fromHex(value) : value])) as Record<keyof typeof defaults, RGBA>
  const theme = {
    hue: { accent: { 300: c.accent }, interactive: { 300: c.value } },
    border: { base: c.border },
    background: { base: c.background, raised: { base: c.panel }, action: { primary: { selected: c.selectedBackground } } },
    text: {
      base: c.text, muted: c.muted, action: { primary: { selected: c.selectedText } },
      feedback: { success: { base: c.success }, warning: { base: c.warning }, error: { base: c.error } },
    },
    surface: () => theme,
  }
  return theme as unknown as Context["theme"]
}

/** An owned directory below the OS temp parent; remove only what this fixture created. */
export function tempDir(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) }
}
