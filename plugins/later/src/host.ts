import { errorMessage } from "@opcode/core"
import type { SetTimer } from "@opcode/core/refresh"
import { pasteIntoPrompt } from "@opcode/ui/paste"
import { snapshotRoute } from "@opcode/ui/screen"
import type { Context } from "@opencode/plugin/tui/context"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createSignal } from "solid-js"
import { LaterClient, type Remote } from "./client"
import { sameItem, type LaterItem, type Settings } from "./domain"

/** OpenCode-specific orchestration: the server's list, the /later dialog, and its actions. It renders nothing itself. */
export class LaterController {
  private readonly client: LaterClient
  /** Owned here rather than by the dialog, so it reopens on the same tab and item after a native prompt replaced it. */
  readonly tab = createSignal(0)
  readonly focus = { active: createSignal<string>(), completed: createSignal<string>() }
  private opened = false
  /** A native prompt of ours is showing in place of the dialog. */
  private asking = false
  private pasting = false
  private disposed = false
  /** Why the list can't be read, toasted once until it changes. */
  private problem?: string
  private readonly lifetime = new AbortController()

  constructor(private readonly api: Context, remote: Remote, private readonly render: (later: LaterController) => JSX.Element, timer?: SetTimer) {
    this.client = new LaterClient(remote, (message) => {
      if (message && message !== this.problem && !this.disposed) this.toast(message, "error")
      this.problem = message
    }, timer)
    this.client.start()
  }

  list = () => this.client.list()
  settings = () => this.client.settings()

  /** Opens /later on its first tab and item. */
  open(): void {
    this.tab[1](0)
    this.focus.active[1](undefined)
    this.focus.completed[1](undefined)
    this.show()
  }

  private show(): void {
    if (this.disposed) return
    this.api.ui.dialog.show(() => this.render(this), () => { this.opened = false })
    this.opened = true
    this.api.ui.dialog.set({ size: "large", centered: true })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    this.client.dispose()
    if (this.opened || this.asking) this.api.ui.dialog.clear()
  }

  refresh(): void {
    this.client.resync()
  }

  async updateSettings(change: Partial<Settings>): Promise<void> {
    // The server keeps what this doesn't change, so changing the sidebar count never turns the tools back on.
    if (change.agentTools && !this.settings().agentTools && await this.ask(() => this.api.ui.dialog.confirm({
      title: "Turn on agent tools?",
      message: "Adding the tools changes every open session's request, so each one's next message misses the prompt cache once.",
    })) !== true) return
    if (this.disposed) return
    try { await this.client.updateSettings(change) } catch (error) { this.failed(error) }
  }

  async add(): Promise<void> {
    const text = await this.ask(() => this.api.ui.dialog.prompt({ title: "Add for later", placeholder: "What should you return to?" }))
    if (text === undefined) return
    try { this.focus.active[1](await this.client.add(text)) } catch (error) { this.failed(error) }
  }

  async edit(item: LaterItem): Promise<void> {
    const text = await this.ask(() => this.api.ui.dialog.prompt({ title: "Edit Later item", value: item.message }))
    if (text !== undefined) await this.write(() => this.client.edit(item, text))
  }

  /** Completes an active item, or restores a completed one to the end of the active list. */
  toggle(item: LaterItem): Promise<boolean> {
    return item.completedAt === undefined
      ? this.write(() => this.client.complete(item), "Item moved to history.")
      : this.write(() => this.client.restore(item), "Item restored to the end of the active list.")
  }

  async remove(item: LaterItem): Promise<boolean> {
    const confirmed = await this.ask(() => this.api.ui.dialog.confirm({ title: "Delete permanently?", message: item.message }))
    return confirmed === true && await this.write(() => this.client.delete(item), "Item deleted permanently.")
  }

  async move(item: LaterItem, offset: -1 | 1): Promise<void> {
    // Moving past either end changes nothing, which is not a conflict.
    try { await this.client.move(item.id, offset) } catch (error) { this.failed(error) }
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
      // The live list catches an edit elsewhere while the prompt mounts; completing checks the item again on the server.
      result = await pasteIntoPrompt(this.api, destination, item.message, () => !this.disposed,
        () => sameItem(this.client.item(item.id), item), { signal: this.lifetime.signal })
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
      this.stale()
      return
    }
    try {
      const changed = await this.client.complete(item)
      if (this.disposed) return
      this.toast(changed
        ? "Pasted into the prompt and moved to history. Nothing was submitted."
        : "Text pasted, but the item changed and was not marked complete.", changed ? "success" : "warning")
    } catch (error) {
      if (!this.disposed) this.toast(`Text was pasted, but updating the list failed: ${errorMessage(error)}. Check /later before trying again.`, "error")
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

  /** A change the server refused because the item changed elsewhere is reported, never retried on newer content. */
  private async write(send: () => Promise<boolean>, success?: string): Promise<boolean> {
    if (this.disposed) return false
    try {
      const changed = await send()
      if (this.disposed) return changed
      if (!changed) this.stale()
      else if (success) this.toast(success, "success")
      return changed
    } catch (error) {
      this.failed(error)
      return false
    }
  }

  private failed(error: unknown): void {
    if (!this.disposed) this.toast(errorMessage(error), "error")
  }

  private stale(): void {
    this.toast("The item changed elsewhere. Review the refreshed list and try again.", "warning")
  }

  private toast(message: string, variant: "error" | "warning" | "success"): void {
    this.api.ui.toast.show({ title: "Later", message, variant })
  }
}
