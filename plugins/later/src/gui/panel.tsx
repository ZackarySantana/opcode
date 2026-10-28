import { usePlugin } from "@opencode/plugin/gui"
import { createSignal, For, Show } from "solid-js"
import type { LaterItem, LaterState } from "../domain"

export interface LaterActions {
  /** Resolves true once the item is saved. */
  add(text: string): Promise<boolean>
  edit(item: LaterItem): Promise<void>
  /** Completes an active item, or restores a completed one to the end of the list. */
  toggle(item: LaterItem): Promise<void>
  remove(item: LaterItem): Promise<void>
  move(item: LaterItem, offset: -1 | 1): Promise<void>
  /** Inserts the item into the current session's prompt and completes it. */
  use(item: LaterItem): Promise<void>
}

/** The Later side tab: add at the top, active items in order, and completed ones on request. */
export function LaterPanel(props: { list: Pick<LaterState, "active" | "completed">; problem: string | undefined; actions: LaterActions }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const [draft, setDraft] = createSignal("")
  const [adding, setAdding] = createSignal(false)
  const [history, setHistory] = createSignal(false)

  const add = async () => {
    if (!draft().trim() || adding()) return
    setAdding(true)
    try { if (await props.actions.add(draft())) setDraft("") } finally { setAdding(false) }
  }

  return (
    <div class="opcode-later">
      <div class="opcode-later-add">
        <ui.TextInput label={ctx.t("add.label")} placeholder={ctx.t("add.placeholder")} value={draft()} onInput={setDraft} onSubmit={() => void add()} />
        <ui.Button icon="plus" busy={adding()} disabled={!draft().trim()} onClick={() => void add()}>{ctx.t("add.submit")}</ui.Button>
      </div>
      <Show when={props.problem}>{(problem) => <p class="opcode-later-problem">{problem()}</p>}</Show>
      <Show when={props.list.active.length} fallback={<p class="opcode-later-muted">{ctx.t("empty")}</p>}>
        <ol class="opcode-later-list">
          <For each={props.list.active}>{(item, index) => (
            <li class="opcode-later-item">
              <span class="opcode-later-number">{index() + 1}.</span>
              <span class="opcode-later-message">{item.message}</span>
              <span class="opcode-later-actions">
                <ui.Tooltip value={ctx.t("item.use.tooltip")}>
                  <ui.Button size="small" variant="ghost" onClick={() => void props.actions.use(item)}>{ctx.t("item.use")}</ui.Button>
                </ui.Tooltip>
                <ui.Menu label={ctx.t("item.actions")} trigger="icon" icon="outline-dots" placement="bottom-end" items={[
                  { label: ctx.t("item.edit"), icon: "edit", onSelect: () => void props.actions.edit(item) },
                  { label: ctx.t("item.up"), icon: "arrow-up", disabled: index() === 0, onSelect: () => void props.actions.move(item, -1) },
                  { label: ctx.t("item.down"), icon: "arrow-down-to-line", disabled: index() === props.list.active.length - 1, onSelect: () => void props.actions.move(item, 1) },
                  { label: ctx.t("item.complete"), icon: "check", onSelect: () => void props.actions.toggle(item) },
                  { type: "separator" },
                  { label: ctx.t("item.delete"), icon: "trash", onSelect: () => void props.actions.remove(item) },
                ]} />
              </span>
            </li>
          )}</For>
        </ol>
      </Show>
      <Show when={props.list.completed.length}>
        <div>
          <ui.Button size="small" variant="ghost-muted" onClick={() => setHistory(!history())}>
            {history() ? ctx.t("history.hide") : ctx.plural("history.show", props.list.completed.length)}
          </ui.Button>
        </div>
        <Show when={history()}>
          <ul class="opcode-later-list">
            <For each={props.list.completed}>{(item) => (
              <li class="opcode-later-item">
                <span class="opcode-later-number opcode-later-muted">✓</span>
                <span class="opcode-later-message opcode-later-muted">{item.message}</span>
                <span class="opcode-later-actions">
                  <ui.Menu label={ctx.t("item.actions")} trigger="icon" icon="outline-dots" placement="bottom-end" items={[
                    { label: ctx.t("item.restore"), icon: "arrow-undo-down", onSelect: () => void props.actions.toggle(item) },
                    { label: ctx.t("item.edit"), icon: "edit", onSelect: () => void props.actions.edit(item) },
                    { type: "separator" },
                    { label: ctx.t("item.delete"), icon: "trash", onSelect: () => void props.actions.remove(item) },
                  ]} />
                </span>
              </li>
            )}</For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}
