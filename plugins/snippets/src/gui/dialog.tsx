import { usePlugin } from "@opencode/plugin/gui"
import { createMemo, createSignal, For, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import type { SnippetsRemote } from "../rpc"
import type { SnippetEntry } from "../service"
import type { SnippetActions } from "./actions"
import { duplicateStart, editStart, newStart, type EditorStart } from "./draft"
import { Editor } from "./editor"
import { displayOrder, filterSnippets, flagOf, groupSnippets, rowKey, step, summary } from "./list"

type View = { kind: "list" } | { kind: "editor"; start: EditorStart }

export interface SnippetsDialogProps {
  remote: Pick<SnippetsRemote, "list">
  actions: SnippetActions
  describeError(error: unknown): string
  /** Opens straight into the editor; leaving it, by saving or cancelling, closes the dialog. */
  editor?: EditorStart
  /** Runs after a save from an editor the dialog opened with. */
  onSaved?(name: string): void
  close(): void
}

/** The snippet list with a preview of the selected one, and the editor, which returns to the list. */
export function SnippetsDialog(props: SnippetsDialogProps) {
  const ctx = usePlugin()
  const [view, setView] = createSignal<View>(props.editor ? { kind: "editor", start: props.editor } : { kind: "list" })
  const [rows, setRows] = createSignal<SnippetEntry[]>()
  const [problem, setProblem] = createSignal<string>()
  const [selected, setSelected] = createSignal<string>()
  const [footer, setFooter] = createSignal<JSX.Element>()

  let loading: AbortController | undefined
  async function load() {
    loading?.abort()
    const controller = loading = new AbortController()
    try {
      const list = await props.remote.list(controller.signal)
      if (controller.signal.aborted) return
      setRows(list.snippets)
      setProblem(undefined)
    } catch (error) {
      if (!controller.signal.aborted) setProblem(props.describeError(error))
    }
  }
  onCleanup(() => loading?.abort())
  if (!props.editor) void load()

  const edit = (start: EditorStart) => setView({ kind: "editor", start })
  const back = (select?: string) => {
    if (props.editor) return props.close()
    if (select) setSelected(select)
    setView({ kind: "list" })
    void load()
  }

  const title = () => {
    const current = view()
    if (current.kind === "list") return ctx.t("title")
    return current.start.from ? ctx.t("editor.edit.title", { name: current.start.from.name }) : ctx.t("editor.new.title")
  }

  return (
    <ctx.ui.Dialog title={title()} size="x-large" footer={footer()}>
      <Switch>
        <Match when={view().kind === "list"}>
          <List rows={rows()} problem={problem()} selected={selected()} select={setSelected} retry={() => void load()}
            footer={setFooter} actions={props.actions} close={props.close} reload={() => void load()}
            edit={(row) => edit(editStart(row))} duplicate={(row) => edit(duplicateStart(row, rows() ?? []))} create={() => edit(newStart())} />
        </Match>
        <Match when={view().kind === "editor" && view() as Extract<View, { kind: "editor" }>}>
          {(current) => (
            <Editor start={current().start} actions={props.actions} footer={setFooter} onCancel={() => back()}
              onSaved={(saved) => {
                // Closes first, so a question that follows the save does not belong to this dialog.
                back(rowKey(saved))
                if (props.editor) props.onSaved?.(saved.name)
              }} />
          )}
        </Match>
      </Switch>
    </ctx.ui.Dialog>
  )
}

interface ListProps {
  rows: SnippetEntry[] | undefined
  problem: string | undefined
  selected: string | undefined
  select(key: string): void
  retry(): void
  reload(): void
  footer(element: JSX.Element): void
  actions: Pick<SnippetActions, "insert" | "remove">
  close(): void
  edit(row: SnippetEntry): void
  duplicate(row: SnippetEntry): void
  create(): void
}

function List(props: ListProps) {
  const ctx = usePlugin()
  const [query, setQuery] = createSignal("")
  const groups = createMemo(() => groupSnippets(filterSnippets(props.rows ?? [], query())))
  const ordered = createMemo(() => displayOrder(groups()))
  // The selection follows the filter: a row that no longer shows gives way to the first one that does.
  const current = createMemo(() => ordered().find((row) => rowKey(row) === props.selected) ?? ordered()[0])

  const insert = (row: SnippetEntry) => { if (props.actions.insert(row)) props.close() }
  const remove = async (row: SnippetEntry) => { if (await props.actions.remove(row)) props.reload() }

  const keydown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    const next = step(ordered(), current() && rowKey(current()!), event.key === "ArrowDown" ? 1 : -1)
    if (next) props.select(rowKey(next))
  }

  props.footer(
    <div class="opcode-snippets-footer">
      <span class="opcode-snippets-hint opcode-snippets-muted opcode-snippets-small">{ctx.t("list.hint")}</span>
      <ctx.ui.Button variant="contrast" icon="plus" onClick={() => props.create()}>{ctx.t("action.new")}</ctx.ui.Button>
    </div>,
  )

  return (
    <Switch>
      <Match when={props.problem && !props.rows}>
        <div class="opcode-snippets-center">
          <div class="opcode-snippets-error">{ctx.t("toast.loadFailed")}: {props.problem}</div>
          <ctx.ui.Button variant="neutral" icon="refresh" onClick={() => props.retry()}>{ctx.t("action.retry")}</ctx.ui.Button>
        </div>
      </Match>
      <Match when={!props.rows}>
        <div class="opcode-snippets-center"><ctx.ui.Loader size="large" /></div>
      </Match>
      <Match when={!props.rows!.length}>
        <div class="opcode-snippets-center">
          <strong>{ctx.t("empty.title")}</strong>
          <span class="opcode-snippets-muted">{ctx.t("empty.description")}</span>
        </div>
      </Match>
      <Match when={props.rows}>
        <div class="opcode-snippets">
          <div class="opcode-snippets-side" onKeyDown={keydown}>
            <ctx.ui.TextInput type="search" value={query()} onInput={setQuery} label={ctx.t("search.label")} placeholder={ctx.t("search.placeholder")}
              autofocus onSubmit={() => { const row = current(); if (row) insert(row) }} />
            <div class="opcode-snippets-list" role="listbox" aria-label={ctx.t("title")}>
              <Show when={ordered().length} fallback={<div class="opcode-snippets-center opcode-snippets-muted">{ctx.t("search.none")}</div>}>
                <For each={groups()}>{(group) => (
                  <>
                    <h3 class="opcode-snippets-heading">{ctx.t(`group.${group.scope}`)}</h3>
                    <For each={group.rows}>{(row) => <Row row={row} selected={current() === row} select={() => props.select(rowKey(row))} insert={() => insert(row)} />}</For>
                  </>
                )}</For>
              </Show>
            </div>
          </div>
          <Show when={current()}>{(row) => (
            <Preview row={row()} insert={() => insert(row())} edit={() => props.edit(row())} duplicate={() => props.duplicate(row())} remove={() => void remove(row())} />
          )}</Show>
        </div>
      </Match>
    </Switch>
  )
}

function Row(props: { row: SnippetEntry; selected: boolean; select(): void; insert(): void }) {
  const ctx = usePlugin()
  const flag = () => flagOf(props.row)
  return (
    <button type="button" role="option" class="opcode-snippets-row" aria-selected={props.selected} title={ctx.t("list.row.title")}
      onClick={() => props.select()} onDblClick={() => props.insert()}>
      <span class="opcode-snippets-line">
        <span class="opcode-snippets-name">@{props.row.name}</span>
        <Show when={props.row.aliases.length}>
          <span class="opcode-snippets-muted opcode-snippets-small opcode-snippets-clip">{props.row.aliases.map((alias) => `@${alias}`).join(" ")}</span>
        </Show>
        <Show when={flag()}>{(flag) => <span class="opcode-snippets-flag">{ctx.t(`flag.${flag()}`)}</span>}</Show>
      </span>
      <span class="opcode-snippets-muted opcode-snippets-small opcode-snippets-clip">{summary(props.row)}</span>
    </button>
  )
}

function Preview(props: { row: SnippetEntry; insert(): void; edit(): void; duplicate(): void; remove(): void }) {
  const ctx = usePlugin()
  const [raw, setRaw] = createSignal(false)
  const differs = () => props.row.expanded !== props.row.body
  const flag = () => flagOf(props.row)
  return (
    <div class="opcode-snippets-preview">
      <div class="opcode-snippets-title">
        <h3>@{props.row.name}</h3>
        <span class="opcode-snippets-muted opcode-snippets-small">{ctx.t(`group.${props.row.scope}`)}</span>
        <Show when={flag()}>{(flag) => <span class="opcode-snippets-flag">{ctx.t(`flag.${flag()}`)}</span>}</Show>
      </div>
      <Show when={props.row.description}><div>{props.row.description}</div></Show>
      <Show when={props.row.aliases.length}>
        <div class="opcode-snippets-muted">{ctx.t("preview.aliases", { aliases: props.row.aliases.map((alias) => `@${alias}`).join(" ") })}</div>
      </Show>
      <Show when={props.row.overridden}><div class="opcode-snippets-error">{ctx.t("insert.overridden", { name: props.row.name })}</div></Show>
      <Show when={props.row.conflict}><div class="opcode-snippets-error">{ctx.t("insert.conflict", { name: props.row.name })}</div></Show>
      <div class="opcode-snippets-actions">
        <ctx.ui.Button variant="contrast" disabled={props.row.overridden || props.row.conflict} onClick={() => props.insert()}>{ctx.t("action.insert")}</ctx.ui.Button>
        <ctx.ui.Button variant="neutral" icon="edit" onClick={() => props.edit()}>{ctx.t("action.edit")}</ctx.ui.Button>
        <ctx.ui.Button variant="neutral" icon="copy" onClick={() => props.duplicate()}>{ctx.t("action.duplicate")}</ctx.ui.Button>
        <ctx.ui.Button variant="danger" icon="trash" onClick={() => props.remove()}>{ctx.t("action.delete")}</ctx.ui.Button>
      </div>
      <Show when={differs()}>
        <ctx.ui.Switch checked={raw()} onChange={setRaw} label={ctx.t("preview.raw")} description={ctx.t("preview.raw.description")} />
      </Show>
      <ctx.ui.Code content={raw() && differs() ? props.row.body : props.row.expanded} language="markdown" />
      <Show when={props.row.problems.length}>
        <div class="opcode-snippets-field">
          <span class="opcode-snippets-label">{ctx.t("preview.problems")}</span>
          <ul class="opcode-snippets-warning"><For each={props.row.problems}>{(problem) => <li>{problem}</li>}</For></ul>
        </div>
      </Show>
      <Show when={props.row.breaks.length}>
        <div class="opcode-snippets-muted">{ctx.t("preview.usedBy", { names: props.row.breaks.map((name) => `@${name}`).join(", ") })}</div>
      </Show>
      <div class="opcode-snippets-path opcode-snippets-muted">{props.row.path}</div>
    </div>
  )
}
