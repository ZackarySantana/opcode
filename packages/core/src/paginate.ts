export type Page<T, C extends string = string> = { data: readonly T[]; cursor: { next?: C | null } }

/** Yield each page's items; the caller owns first-page params because cursors carry them afterward. */
export async function* paginate<T, C extends string = string>(
  fetchPage: (cursor: C | undefined) => Promise<Page<T, C>>, signal?: AbortSignal,
): AsyncGenerator<readonly T[], void, undefined> {
  const seen = new Set<C>()
  let cursor: C | undefined
  do {
    signal?.throwIfAborted()
    const page = await fetchPage(cursor)
    signal?.throwIfAborted()
    cursor = page.cursor.next ?? undefined
    if (cursor !== undefined && seen.has(cursor)) throw new Error("History pagination repeated a cursor.")
    if (cursor !== undefined) seen.add(cursor)
    yield page.data
  } while (cursor)
}
