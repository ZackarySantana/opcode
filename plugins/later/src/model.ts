import { reconcileSelection, sameItem, visibleItems, type LaterItem, type LaterSnapshot } from "./domain"
import type { LaterDatabase } from "./sqlite"

export interface LaterView extends LaterSnapshot {
  readonly history: boolean
  readonly selectedID?: string
}

/** Selection is client-local; list contents and revisions come from SQLite. */
export class LaterModel {
  private snapshot: LaterSnapshot
  private history = false
  private selectedID?: string

  constructor(private readonly database: LaterDatabase) {
    this.snapshot = database.snapshot()
    this.reconcile()
  }

  view(): LaterView {
    return { ...this.snapshot, history: this.history, selectedID: this.selectedID }
  }

  rows(): readonly LaterItem[] {
    return visibleItems(this.snapshot, this.history)
  }

  refresh(force = false): boolean {
    if (!force && this.database.revision() === this.snapshot.revision) return false
    this.snapshot = this.database.snapshot()
    this.reconcile()
    return true
  }

  open(): void {
    this.history = false
    this.selectedID = undefined
    this.refresh(true)
  }

  toggleHistory(): void {
    this.history = !this.history
    this.reconcile()
  }

  select(offset: -1 | 1): void {
    this.refresh()
    const rows = this.rows()
    const index = rows.findIndex((item) => item.id === this.selectedID)
    this.selectedID = rows[Math.max(0, Math.min(rows.length - 1, index + offset))]?.id
  }

  selectID(id?: string): void {
    this.selectedID = reconcileSelection(this.rows(), id)
  }

  predecessor(id: string): string | undefined {
    const rows = this.rows()
    return rows[rows.findIndex((item) => item.id === id) - 1]?.id
  }

  /** Never silently substitute another item when a command races an external change. */
  target(): LaterItem | undefined {
    const before = this.rows().find((item) => item.id === this.selectedID)
    this.refresh()
    if (!before) return undefined
    const current = this.rows().find((item) => item.id === before.id)
    return sameItem(current, before) ? current : undefined
  }

  private reconcile(): void {
    this.selectedID = reconcileSelection(this.rows(), this.selectedID)
  }
}
