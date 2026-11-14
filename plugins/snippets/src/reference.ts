import { RGBA } from "@opentui/core"
import { effectiveSnippets } from "./domain"
import type { SnippetEntry } from "./service"

/** References to snippets stand out in purple, in every theme. */
export const REFERENCE = RGBA.fromHex("#a371f7")

/** Every name and alias that inserts a snippet here, so a view can color references to them. */
export const snippetKeys = (rows: readonly SnippetEntry[]) => new Set(effectiveSnippets(rows).keys())
