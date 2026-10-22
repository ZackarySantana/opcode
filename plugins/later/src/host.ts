import { errorMessage } from "@opcode/core"
import { createScreen, ownsScreen, type Screen } from "@opcode/ui/screen"
import type { Context, KeymapCommand, Route } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { sameItem, type LaterItem } from "./domain"
import { LaterModel } from "./model"
import { pasteIntoPrompt } from "./paste"
import type { LaterDatabase } from "./sqlite"

export const MANAGER_ROUTE = "opcode-later.manage"
export const MANAGER_MODE = "opcode-later.manage"
type Action = "open" | "close" | "refresh" | "history" | "up" | "down" | "moveUp" | "moveDown" | "add" | "edit" | "complete" | "delete" | "paste"

export function isManager(route: Route): boolean {
  return ownsScreen(route, { id: "opcode-later", name: MANAGER_ROUTE })
}

/** OpenCode-specific orchestration. It owns no renderer tree or server state. */
export class LaterController {
  readonly model: LaterModel
  readonly screen: Screen
  private readonly pending = createSignal(false)
  get busy() { return this.pending[0]() }
  set busy(value: boolean) { this.pending[1](value) }
  private disposed = false
  private pollError?: string
  private readonly lifetime = new AbortController()

  constructor(private readonly api: Context, private readonly database: LaterDatabase, private readonly changed: () => void) {
    this.model = new LaterModel(database)
    this.screen = createScreen(api, { id: "opcode-later", name: MANAGER_ROUTE, mode: MANAGER_MODE })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    this.screen.dispose()
  }

  poll(): void {
    if (this.disposed) return
    try {
      if (this.model.refresh()) this.changed()
      this.pollError = undefined
    } catch (error) {
      const message = errorMessage(error)
      if (message !== this.pollError) this.toast(message, "error")
      this.pollError = message
    }
  }

  command(action: Action, title: string, bind?: string): KeymapCommand {
    return {
      id: `opcode-later.${action}`,
      title,
      bind,
      enabled: () => !this.disposed && (action === "close" || action === "open" || !this.busy),
      run: () => this.run(action),
    }
  }

  /** Native dialogs may never settle, so they never hold busy; interaction() rejects their stale results. */
  async run(action: Action): Promise<void> {
    if (this.disposed) return
    if (action === "close") { this.screen.close(); return }
    if (action !== "open" && (this.busy || !this.screen.active())) return
    try {
      await this.perform(action)
    } catch (error) {
      if (!this.disposed) this.toast(errorMessage(error), "error")
    } finally {
      if (!this.disposed) this.changed()
    }
  }

  private async perform(action: Exclude<Action, "close">): Promise<void> {
    if (action === "open") {
      const route = this.api.ui.router.current()
      if (isManager(route)) return
      this.model.open()
      this.screen.open()
      return
    }
    if (action === "refresh") { this.model.refresh(true); return }
    if (action === "history") { this.model.refresh(); this.model.toggleHistory(); return }
    if (action === "up" || action === "down") { this.model.select(action === "up" ? -1 : 1); return }
    if (action === "add") { await this.add(); return }

    const item = this.model.target()
    this.changed()
    if (!item) {
      if (this.model.rows().length) this.stale()
      return
    }
    if (action === "edit") { await this.edit(item); return }
    if (action === "delete") { await this.remove(item); return }
    if (action === "paste") { await this.paste(item); return }
    if (action === "moveUp" || action === "moveDown") {
      if (item.completedAt === undefined) this.database.move(item, action === "moveUp" ? -1 : 1)
      this.model.refresh(true)
      return
    }
    const previousID = this.model.predecessor(item.id)
    const completed = item.completedAt !== undefined
    const changed = completed ? this.database.restore(item) : this.database.complete(item)
    this.model.refresh(true)
    if (!changed) { this.stale(); return }
    this.model.selectID(previousID)
    this.toast(completed ? "Item restored to the end of the active list." : "Item moved to history.", "success")
  }

  private async add(): Promise<void> {
    const valid = this.screen.interaction()
    const text = await this.api.ui.dialog.prompt({ title: "Add for later", placeholder: "What should you return to?" })
    if (text === undefined || !valid()) return
    this.database.add(text)
    this.model.refresh(true)
  }

  private async edit(item: LaterItem): Promise<void> {
    const valid = this.screen.interaction()
    const text = await this.api.ui.dialog.prompt({ title: "Edit Later item", value: item.message })
    if (text === undefined || !valid()) return
    const changed = this.database.edit(item, text)
    this.model.refresh(true)
    if (!changed) this.stale()
  }

  private async remove(item: LaterItem): Promise<void> {
    const valid = this.screen.interaction()
    const previousID = this.model.predecessor(item.id)
    const confirmed = await this.api.ui.dialog.confirm({ title: "Delete permanently?", message: item.message })
    if (!confirmed || !valid()) return
    const changed = this.database.delete(item)
    this.model.refresh(true)
    if (!changed) { this.stale(); return }
    this.model.selectID(previousID)
    this.toast("Item deleted permanently.", "success")
  }

  private async paste(item: LaterItem): Promise<void> {
    if (item.completedAt !== undefined) return
    const back = this.screen.previous()
    if (back.type === "plugin") {
      this.toast("Open Later from home or a session to paste into its prompt.", "warning")
      return
    }
    // Delivery always settles (readiness timeout), so it alone holds busy to prevent a second paste.
    this.busy = true
    this.changed()
    let result
    try {
      result = await pasteIntoPrompt(
        this.api, back, item.message,
        () => !this.disposed,
        () => sameItem(this.database.get(item.id), item),
        { signal: this.lifetime.signal },
      )
    } finally { this.busy = false }
    if (this.disposed || result === "cancelled") return
    if (result === "unavailable") {
      this.toast("The prompt is not ready. The item is still active; open /later and try again.", "error")
      return
    }
    if (result === "changed") {
      this.model.refresh(true)
      this.stale()
      return
    }
    try {
      const changed = this.database.complete(item)
      this.model.refresh(true)
      this.toast(changed
        ? "Pasted into the prompt and moved to history. Nothing was submitted."
        : "Text pasted, but the item changed and was not marked complete.", changed ? "success" : "warning")
    } catch (error) {
      this.toast(`Text was pasted, but updating the list failed: ${errorMessage(error)}. Check /later before trying again.`, "error")
    }
  }

  private stale(): void {
    this.toast("The item changed elsewhere. Review the refreshed list and try again.", "warning")
  }

  private toast(message: string, variant: "error" | "warning" | "success"): void {
    this.api.ui.toast.show({ title: "Later", message, variant })
  }
}
