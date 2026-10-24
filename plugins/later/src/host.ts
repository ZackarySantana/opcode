import { errorMessage } from "@opcode/core"
import { pasteIntoPrompt } from "@opcode/ui/paste"
import { snapshotRoute } from "@opcode/ui/screen"
import type { Context } from "@opencode/plugin/tui/context"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createSignal, type Signal } from "solid-js"
import { sameItem, type LaterItem, type LaterSnapshot, type Settings } from "./domain"
import type { LaterDatabase } from "./sqlite"

export const PREFIX = "opcode-later"

/** OpenCode-specific orchestration: the latest list, the /later dialog, and its actions. It renders nothing itself. */
export class LaterController {
  private readonly state: Signal<LaterSnapshot>
  private readonly settingsSignal: Signal<Settings>
  /** Owned here rather than by the dialog, so it reopens on the same tab and item after a native prompt replaced it. */
  readonly tab = createSignal(0)
  readonly focus = { active: createSignal<string>(), completed: createSignal<string>() }
  private opened = false
  /** A native prompt of ours is showing in place of the dialog. */
  private asking = false
  private pasting = false
  private disposed = false
  private pollError?: string
  private readonly lifetime = new AbortController()

  constructor(private readonly api: Context, private readonly database: LaterDatabase, private readonly render: (later: LaterController) => JSX.Element) {
    this.state = createSignal(database.snapshot())
    this.settingsSignal = createSignal(database.settings())
  }

  snapshot = () => this.state[0]()
  settings = () => this.settingsSignal[0]()

  /** Opens /later on its first tab and item. */
  open(): void {
    this.tab[1](0)
    this.focus.active[1](undefined)
    this.focus.completed[1](undefined)
    this.show()
  }

  private show(): void {
    if (this.disposed) return
    this.refresh()
    this.api.ui.dialog.show(() => this.render(this), () => { this.opened = false })
    this.opened = true
    this.api.ui.dialog.set({ size: "large", centered: true })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    if (this.opened || this.asking) this.api.ui.dialog.clear()
  }

  /** Picks up changes from other clients and the agent's tools, which share the database. */
  poll(): void {
    if (this.disposed) return
    try {
      if (this.database.revision() !== this.snapshot().revision) this.refresh()
      this.pollError = undefined
    } catch (error) {
      const message = errorMessage(error)
      if (message !== this.pollError) this.toast(message, "error")
      this.pollError = message
    }
  }

  refresh(): void {
    this.state[1](this.database.snapshot())
  }

  async updateSettings(change: Partial<Settings>): Promise<void> {
    try {
      // Read fresh: another terminal may have turned the tools off, and saving a stale "on" would skip the warning.
      const current = this.database.settings()
      const next = { ...current, ...change }
      if (next.agentTools && !current.agentTools && await this.ask(() => this.api.ui.dialog.confirm({
        title: "Turn on agent tools?",
        message: "Adding the tools changes every open session's request, so each one's next message misses the prompt cache once.",
      })) !== true) return
      this.database.saveSettings(next)
      this.settingsSignal[1](next)
    } catch (error) { this.toast(errorMessage(error), "error") }
  }

  async add(): Promise<void> {
    const text = await this.ask(() => this.api.ui.dialog.prompt({ title: "Add for later", placeholder: "What should you return to?" }))
    if (text !== undefined) this.write(() => { this.focus.active[1](this.database.add(text)); return true })
  }

  async edit(item: LaterItem): Promise<void> {
    const text = await this.ask(() => this.api.ui.dialog.prompt({ title: "Edit Later item", value: item.message }))
    if (text !== undefined) this.write(() => this.database.edit(item, text))
  }

  /** Completes an active item, or restores a completed one to the end of the active list. */
  toggle(item: LaterItem): boolean {
    return item.completedAt === undefined
      ? this.write(() => this.database.complete(item), "Item moved to history.")
      : this.write(() => this.database.restore(item), "Item restored to the end of the active list.")
  }

  async remove(item: LaterItem): Promise<boolean> {
    const confirmed = await this.ask(() => this.api.ui.dialog.confirm({ title: "Delete permanently?", message: item.message }))
    return confirmed === true && this.write(() => this.database.delete(item), "Item deleted permanently.")
  }

  move(item: LaterItem, offset: -1 | 1): void {
    // Moving past either end changes nothing, which is not a conflict.
    this.write(() => { this.database.move(item, offset); return true })
  }

  /** Closes the dialog, pastes the item into the prompt behind it without submitting, and completes it. */
  async paste(item: LaterItem): Promise<void> {
    if (this.pasting || item.completedAt !== undefined) return
    const destination = snapshotRoute(this.api.ui.router.current())
    if (destination.type === "plugin") {
      this.toast("Open Later from home or a session to paste into its prompt.", "warning")
      return
    }
    this.api.ui.dialog.clear()
    // Delivery always settles (readiness timeout), so it alone holds `pasting` to prevent a second paste.
    this.pasting = true
    let result
    try {
      result = await pasteIntoPrompt(this.api, destination, item.message, () => !this.disposed,
        () => sameItem(this.database.get(item.id), item), { signal: this.lifetime.signal })
    } catch (error) {
      if (!this.disposed) this.toast(errorMessage(error), "error")
      return
    } finally { this.pasting = false }
    if (this.disposed || result === "cancelled") return
    if (result === "unavailable") {
      this.toast("The prompt is not ready. The item is still active; open /later and try again.", "error")
      return
    }
    if (result === "changed") {
      this.refresh()
      this.stale()
      return
    }
    try {
      const changed = this.database.complete(item)
      this.refresh()
      this.toast(changed
        ? "Pasted into the prompt and moved to history. Nothing was submitted."
        : "Text pasted, but the item changed and was not marked complete.", changed ? "success" : "warning")
    } catch (error) {
      this.toast(`Text was pasted, but updating the list failed: ${errorMessage(error)}. Check /later before trying again.`, "error")
    }
  }

  /**
   * Native prompts replace this dialog, so it reopens when the prompt closes. If another dialog replaced the prompt
   * instead (the host keeps its `modal` input mode while any dialog is open), that one stays and the answer is dropped.
   */
  private async ask<T>(dialog: () => Promise<T | undefined>): Promise<T | undefined> {
    this.asking = true
    const answer = await dialog().finally(() => { this.asking = false })
    if (this.disposed || this.api.keymap.mode.current() === "modal") return undefined
    this.show()
    return answer
  }

  /** A write the database refused because the item changed elsewhere is reported, never retried on newer content. */
  private write(operation: () => boolean, success?: string): boolean {
    try {
      const changed = operation()
      this.refresh()
      if (!changed) this.stale()
      else if (success) this.toast(success, "success")
      return changed
    } catch (error) {
      this.toast(errorMessage(error), "error")
      return false
    }
  }

  private stale(): void {
    this.toast("The item changed elsewhere. Review the refreshed list and try again.", "warning")
  }

  private toast(message: string, variant: "error" | "warning" | "success"): void {
    this.api.ui.toast.show({ title: "Later", message, variant })
  }
}
