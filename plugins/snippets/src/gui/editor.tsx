import { usePlugin } from "@opencode/plugin/gui"
import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { scopes } from "../domain"
import { saveRequest, type Draft } from "../draft"
import { changed, type EditorStart } from "./draft"
import type { SnippetActions } from "./actions"

export interface EditorProps {
  start: EditorStart
  actions: Pick<SnippetActions, "save">
  /** Runs after a save, with the saved name and scope. */
  onSaved(saved: { name: string; scope: Draft["scope"] }): void
  /** Runs when the user leaves without saving, after confirming any discard. */
  onCancel(): void
  /** Receives the footer's buttons, which the dialog shows in its last row. */
  footer(element: JSX.Element): void
}

/** A snippet's name, scope, description, aliases, and text. Errors from the server show here, and the editor stays. */
export function Editor(props: EditorProps) {
  const ctx = usePlugin()
  const [draft, setDraft] = createSignal<Draft>({ ...props.start.draft })
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  let body: HTMLTextAreaElement | undefined

  // Editing starts in the text; a new snippet starts at its name, which the name field's autofocus covers.
  onMount(() => { if (props.start.from || props.start.draft.body) body?.focus() })

  async function save() {
    if (saving()) return
    setSaving(true)
    setError(undefined)
    const payload = saveRequest(draft(), props.start.from)
    const result = await props.actions.save(payload)
    setSaving(false)
    if (result.ok) props.onSaved({ name: payload.name, scope: payload.scope })
    else setError(result.error)
  }

  async function cancel() {
    if (changed(props.start, draft()) && !await ctx.dialogs.confirm({
      title: ctx.t("discard.title"), description: ctx.t("discard.description"), confirm: ctx.t("discard.confirm"), danger: true,
    })) return
    props.onCancel()
  }

  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault()
      void save()
    }
  }

  props.footer(
    <div class="opcode-snippets-footer">
      <span class="opcode-snippets-hint opcode-snippets-muted opcode-snippets-small">{ctx.t("editor.hint")}</span>
      <ctx.ui.Button variant="neutral" onClick={() => void cancel()}>{ctx.t("editor.cancel")}</ctx.ui.Button>
      <ctx.ui.Button variant="contrast" busy={saving()} onClick={() => void save()}>{ctx.t("editor.save")}</ctx.ui.Button>
    </div>,
  )

  return (
    <div class="opcode-snippets-form" onKeyDown={keydown}>
      <div class="opcode-snippets-fields">
        <label class="opcode-snippets-field">
          <span class="opcode-snippets-label">{ctx.t("editor.name")}</span>
          <ctx.ui.TextInput value={draft().name} onInput={(value) => set("name", value)} label={ctx.t("editor.name")}
            placeholder={ctx.t("editor.name.placeholder")} size="large" autofocus={!props.start.from && !props.start.draft.body} />
        </label>
        <div class="opcode-snippets-field">
          <span class="opcode-snippets-label" id="opcode-snippets-scope">{ctx.t("editor.scope")}</span>
          <div class="opcode-snippets-scope" role="radiogroup" aria-labelledby="opcode-snippets-scope">
            <For each={[...scopes].reverse()}>{(scope) => (
              <button type="button" role="radio" aria-checked={draft().scope === scope} title={ctx.t(`editor.scope.${scope}.description`)}
                onClick={() => set("scope", scope)}>
                {ctx.t(`group.${scope}`)}
              </button>
            )}</For>
          </div>
        </div>
      </div>
      <label class="opcode-snippets-field">
        <span class="opcode-snippets-label">{ctx.t("editor.description")}</span>
        <ctx.ui.TextInput value={draft().description} onInput={(value) => set("description", value)} label={ctx.t("editor.description")}
          placeholder={ctx.t("editor.description.placeholder")} />
      </label>
      <label class="opcode-snippets-field">
        <span class="opcode-snippets-label">{ctx.t("editor.aliases")}</span>
        <ctx.ui.TextInput value={draft().aliases} onInput={(value) => set("aliases", value)} label={ctx.t("editor.aliases")}
          placeholder={ctx.t("editor.aliases.placeholder")} />
      </label>
      <label class="opcode-snippets-field">
        <span class="opcode-snippets-label">{ctx.t("editor.body")}</span>
        <textarea ref={body} class="opcode-snippets-textarea" value={draft().body} spellcheck={false}
          placeholder={ctx.t("editor.body.placeholder")} onInput={(event) => set("body", event.currentTarget.value)} />
        <span class="opcode-snippets-muted opcode-snippets-small">{ctx.t("editor.body.help")}</span>
      </label>
      <Show when={error()}>{(message) => <div class="opcode-snippets-error" role="alert">{message()}</div>}</Show>
    </div>
  )
}
