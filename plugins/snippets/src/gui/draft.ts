import { draftOf, duplicateOf, emptyDraft, sameDraft, type Draft } from "../draft"
import type { SnippetEntry, SnippetKey } from "../service"

/** What the editor opens with: a draft, and the snippet it replaces when editing one. */
export interface EditorStart {
  draft: Draft
  from?: SnippetKey
}

/** Editing a snippet: saving replaces it, renaming or moving it when the name or scope changed. */
export function editStart(row: SnippetEntry): EditorStart {
  return { draft: draftOf(row), from: { name: row.name, scope: row.scope } }
}

/** A copy, saved as a new snippet. */
export function duplicateStart(row: SnippetEntry, rows: readonly Pick<SnippetEntry, "name" | "aliases">[]): EditorStart {
  return { draft: duplicateOf(row, rows) }
}

/** A new snippet whose text starts as `body`, such as a prompt draft or a message. */
export function newStart(body = ""): EditorStart {
  return { draft: emptyDraft(body.trim()) }
}

/** Whether leaving the editor would lose typing. */
export const changed = (start: EditorStart, draft: Draft) => !sameDraft(start.draft, draft)
