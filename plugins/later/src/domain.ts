export interface LaterItem {
  readonly id: string
  readonly message: string
  readonly position: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
}

export interface LaterSnapshot {
  readonly revision: number
  readonly active: readonly LaterItem[]
  readonly completed: readonly LaterItem[]
}

export function messageText(text: string): string {
  const message = text.trim()
  if (!message) throw new Error("Message cannot be empty")
  return message
}

/** Positions are renumbered when other items leave the list, so they never indicate a stale item. */
export function sameItem(left: LaterItem | undefined, right: LaterItem): boolean {
  return left !== undefined && left.id === right.id && left.message === right.message &&
    left.createdAt === right.createdAt && left.updatedAt === right.updatedAt && left.completedAt === right.completedAt
}

export function visibleItems(snapshot: LaterSnapshot, history: boolean): readonly LaterItem[] {
  return history ? [...snapshot.active, ...snapshot.completed] : snapshot.active
}

export function reconcileSelection(items: readonly LaterItem[], selectedID?: string): string | undefined {
  return items.some((item) => item.id === selectedID) ? selectedID : items[0]?.id
}
