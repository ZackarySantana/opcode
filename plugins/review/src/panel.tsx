/** @jsxImportSource @opentui/solid */

import { errorMessage } from "@opcode/core"
import { createRefresh, type RefreshState } from "@opcode/core/refresh"
import { KeyHints, usePalette, useText } from "@opcode/ui"
import type { FileDiffInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { CliRenderEvents, pathToFiletype, type BoxRenderable, type ScrollBoxRenderable, type SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import type { Position, ReviewController } from "./host"
import { hunkStarts, lineOf, parsePatch, segments, type Segment } from "./patch"
import {
  anchorOf, drafts, isQuestion, lineRange, locate, modes, modeTitle, nearestRow, placeComments, PLUGIN_ID,
  type Anchor, type Comment, type Delivery, type FileList as FileListStyle, type Mode, type Reply,
} from "./review"
import { FileList } from "./files"
import { listBranches, loadDiff } from "./source"
import { treeOrder } from "./tree"

/** Below this width the file list gives way to the diff; the header still names the file. */
const TREE_WIDTH = 100

const describe: Record<Mode, string> = {
  turn: "What the agent changed since your last prompt",
  session: "Everything this session changed",
  working: "Uncommitted changes in the worktree, from any session",
  branch: "The worktree against a base branch, from any session",
}

const deliveryLabel: Record<Delivery, string> = {
  draft: "draft",
  sending: "sending",
  unconfirmed: "not confirmed: S retries",
  pending: "waiting for the agent",
  sent: "sent",
}

/** Live diffs of a session with comments between the lines. Everything it remembers lives in the controller, so closing it loses nothing. */
export function ReviewPanel(props: { panel: PanelInput; review: ReviewController; syntax?: () => SyntaxStyle | undefined }) {
  const api = usePlugin()
  const palette = usePalette()
  const text = useText()
  const review = props.review
  // Comments go to the conversation you are in; a subagent's panel reviews its parent.
  const sessionID = createMemo(() => api.data.session.root(props.panel.sessionID))
  const state = () => review.review(sessionID())
  const mode = () => state().mode
  const view = () => mode() === "branch" ? `${modeTitle.branch} vs ${state().base ?? "its base"}` : modeTitle[mode()]

  const [diff, setDiff] = createSignal<RefreshState<FileDiffInfo[]>>({ loading: false })
  const reads = createRefresh((signal) => {
    const id = sessionID()
    const directory = review.directory(id)
    if (!directory) throw new Error("This session has no directory to review.")
    return loadDiff(api.client, { sessionID: id, directory }, mode(), state().base, signal)
  }, setDiff, { delay: 200, timer: review.timer })
  // Only a different view drops the diff; comments and viewed marks change the review without changing what it shows.
  const source = createMemo(() => JSON.stringify([sessionID(), mode(), state().base]))
  createEffect(on(source, () => { reads.reset(); void reads.refresh() }))
  createEffect(on(sessionID, (id) => {
    void api.data.session.pending.sync(id).catch(() => undefined)
    review.loadReplies(id)
  }))
  const mine = (id: string) => api.data.session.root(id) === sessionID()
  const stops = [
    api.data.on("session.step.ended", (event) => { if (mine(event.data.sessionID)) reads.schedule() }),
    api.data.on("session.tool.success", (event) => { if (mine(event.data.sessionID)) reads.schedule() }),
    api.data.on("session.idle", (event) => { if (mine(event.data.sessionID)) reads.schedule() }),
    api.data.on("session.revert.committed", (event) => { if (mine(event.data.sessionID)) reads.schedule() }),
    // Your own edits, and every change the uncommitted and branch views show.
    api.data.on("filesystem.changed", () => reads.schedule()),
    api.data.on("vcs.branch.updated", () => reads.schedule()),
  ]
  onCleanup(() => {
    for (const stop of stops) stop()
    reads.dispose()
  })
  const focusRequests = review.focusRequests()
  createEffect(on(review.focusRequests, (count) => { if (count !== focusRequests) props.panel.focus() }, { defer: true }))
  onMount(() => props.panel.focus())

  const files = () => diff().value ?? []
  // Next and previous follow the list as shown.
  const ordered = createMemo(() => {
    if (review.settings().fileList === "paths") return files()
    const byPath = new Map(files().map((entry) => [entry.file, entry]))
    return treeOrder(files().map((entry) => entry.file)).map((path) => byPath.get(path)!)
  })
  const position = () => review.position(sessionID())
  const place = (change: Partial<Position>) => review.setPosition(sessionID(), { ...position(), ...change })
  const file = createMemo(() => files().find((entry) => entry.file === position().file) ?? ordered()[0])
  const fileIndex = () => Math.max(0, ordered().findIndex((entry) => entry.file === file()?.file))
  // Every refresh brings new objects; only a changed patch re-parses, so an unchanged diff (and a comment being typed) stays mounted.
  const patchText = createMemo(() => file()?.patch ?? "")
  const rows = createMemo(() => parsePatch(patchText()))
  const viewed = (entry: FileDiffInfo) => review.isViewed(sessionID(), mode(), entry.file, entry.patch)
  const replies = () => review.repliesFor(sessionID())

  // The cursor is a line, not a row index, so a refresh that adds rows above it doesn't move it.
  const cursor = createMemo(() => nearestRow(rows(), position().line, position().old, position().text))
  const moveTo = (index: number) => {
    const row = rows()[Math.max(0, Math.min(rows().length - 1, index))]
    if (row) place({ file: file()?.file, line: lineOf(row), old: row.kind === "del", text: row.text })
  }
  const [mark, setMark] = createSignal<number>()
  // A range belongs to one file of one session.
  createEffect(on(() => `${sessionID()}:${file()?.file}`, () => setMark(undefined), { defer: true }))
  const selectFile = (index: number) => {
    saveEditor()
    const next = ordered()[Math.max(0, Math.min(ordered().length - 1, index))]
    if (next) place({ file: next.file, line: undefined, old: undefined, text: undefined })
  }

  const comments = createMemo(() => state().comments.filter((comment) => comment.file === file()?.file))
  const placed = createMemo(() => placeComments(comments(), rows()))
  const deliveries = () => review.deliveries(sessionID())
  // Drafts whose text the agent moved take their new lines, which the message and the card show.
  createEffect(on(placed, (list) => {
    const name = file()?.file
    if (!name) return
    for (const { comment, at } of list) {
      if (comment.sent || !at) continue
      const moved = anchorOf(name, rows(), at.from, at.to)
      if (moved.side !== comment.side || moved.start !== comment.start || moved.end !== comment.end) void review.moveComment(sessionID(), comment.id, moved)
    }
  }))
  const editing = () => position().editing
  const editAt = createMemo(() => {
    const edit = editing()
    if (!edit || edit.anchor.file !== file()?.file) return undefined
    return locate(edit.anchor, rows())?.to ?? rows().length - 1
  })
  const breaks = createMemo(() => new Set([...placed().flatMap(({ at }) => at ? [at.to] : []), ...editAt() === undefined ? [] : [editAt()!]]))
  const parts = createMemo<Segment[]>((previous) => {
    const kept = new Map(previous?.map((part) => [`${part.start}:${part.patch}`, part]))
    return segments(rows(), breaks()).map((part) => kept.get(`${part.start}:${part.patch}`) ?? part)
  })
  const commented = createMemo(() => new Set(placed().flatMap(({ at }) => at ? Array.from({ length: at.to - at.from + 1 }, (_, offset) => at.from + offset) : [])))
  const range = () => {
    const from = mark()
    return from === undefined ? undefined : { from: Math.min(from, cursor()), to: Math.max(from, cursor()) }
  }
  /** The draft (or else any comment) covering the cursor. */
  const atCursor = () => {
    const covering = placed().filter(({ at }) => at && at.from <= cursor() && cursor() <= at.to).map(({ comment }) => comment)
    return covering.find((comment) => !comment.sent) ?? covering[0]
  }

  const startComment = () => {
    const existing = atCursor()
    if (existing && !existing.sent) {
      // A plain copy: the memory store must not hold the synced store's live objects.
      const { file, side, start, end, quote } = existing
      place({ editing: { id: existing.id, anchor: { file, side, start, end, quote: [...quote] }, text: existing.text } })
      return
    }
    const name = file()?.file
    if (!name || !rows().length) return
    const span = range() ?? { from: cursor(), to: cursor() }
    place({ editing: { anchor: anchorOf(name, rows(), span.from, span.to), text: "" } })
    setMark(undefined)
  }
  let editor: TextareaRenderable | undefined
  /** Saves and closes the comment being written. The text comes from the box while it's open, else from what was typed into it. */
  function saveEditor() {
    const edit = editing()
    if (!edit) return
    const body = (editor && !editor.isDestroyed ? editor.plainText : edit.text).trim()
    if (edit.id) void review.editComment(sessionID(), edit.id, body)
    else if (body) void review.addComment(sessionID(), edit.anchor, body)
    place({ editing: undefined })
    props.panel.focus()
  }
  // A comment whose file left the view (the agent reverted it) is saved rather than left without a box.
  createEffect(() => { if (editing() && diff().value && editing()!.anchor.file !== file()?.file) saveEditor() })

  const send = () => void review.send(sessionID(), view())
  const hasUnsent = () => review.hasUnsent(sessionID())
  /** What to review and how to list the files, in one menu. */
  const openOptions = async () => {
    const shown = (on: boolean, description: string) => on ? `Shown now. ${description}` : description
    const choice = await api.ui.dialog.select<Mode | "base" | FileListStyle>({
      title: "Review options",
      current: mode(),
      options: [
        ...modes.map((value) => ({ title: modeTitle[value], value, description: shown(value === mode(), describe[value]), category: "View" })),
        { title: "Base branch...", value: "base" as const, description: state().base ? `Comparing against ${state().base}` : "Pick what the branch view compares against", category: "View" },
        { title: "Folder tree", value: "tree" as const, description: shown(review.settings().fileList === "tree", "Files under their folders"), category: "File list" },
        { title: "Full paths", value: "paths" as const, description: shown(review.settings().fileList === "paths", "Each file's whole path"), category: "File list" },
      ],
    })
    if (choice === "base") return chooseBase()
    if (choice === "tree" || choice === "paths") return void review.updateSettings({ fileList: choice })
    if (choice) void review.setView(sessionID(), choice)
  }
  const chooseBase = async () => {
    const directory = review.directory(sessionID())
    if (!directory) return
    try {
      const branches = await listBranches(api.client, directory)
      const base = await api.ui.dialog.select({ title: "Compare against", current: state().base, options: branches.map((branch) => ({ title: branch, value: branch })) })
      if (base) void review.setView(sessionID(), "branch", base)
    } catch (error) {
      api.ui.toast.show({ variant: "error", title: "Review", message: errorMessage(error) })
    }
  }
  const toggleFileViewed = () => {
    const entry = file()
    if (!entry) return
    const nowViewed = !viewed(entry)
    void review.toggleViewed(sessionID(), mode(), entry.file, entry.patch)
    if (!nowViewed) return
    // Marking a file viewed moves on to the next one still waiting.
    const order = [...ordered().slice(fileIndex() + 1), ...ordered().slice(0, fileIndex())]
    const next = order.find((candidate) => !viewed(candidate))
    if (next) place({ file: next.file, line: undefined, old: undefined, text: undefined })
  }

  let scroll: ScrollBoxRenderable | undefined
  const page = () => Math.max(1, Math.floor((scroll?.viewport.height ?? 20) / 2))
  const starts = createMemo(() => hunkStarts(rows()))
  const [listShown, setListShown] = createSignal(true)
  const wide = () => props.panel.width >= TREE_WIDTH && listShown()

  // The host scopes a panel's layers to when it owns input; checking focus too keeps a prompt you're typing in safe.
  api.keymap.layer(() => ({
    enabled: () => props.panel.focused && !editing(),
    commands: [
      { id: `${PLUGIN_ID}.down`, title: "Next line", bind: "j,down", run: () => moveTo(cursor() + 1) },
      { id: `${PLUGIN_ID}.up`, title: "Previous line", bind: "k,up", run: () => moveTo(cursor() - 1) },
      { id: `${PLUGIN_ID}.page.down`, title: "Half a page down", bind: "ctrl+d,pagedown", run: () => moveTo(cursor() + page()) },
      { id: `${PLUGIN_ID}.page.up`, title: "Half a page up", bind: "ctrl+u,pageup", run: () => moveTo(cursor() - page()) },
      { id: `${PLUGIN_ID}.first`, title: "First line", bind: "g,home", run: () => moveTo(0) },
      { id: `${PLUGIN_ID}.last`, title: "Last line", bind: "shift+g,end", run: () => moveTo(rows().length - 1) },
      { id: `${PLUGIN_ID}.hunk.next`, title: "Next hunk", bind: "]", run: () => moveTo(starts().find((start) => start > cursor()) ?? cursor()) },
      { id: `${PLUGIN_ID}.hunk.previous`, title: "Previous hunk", bind: "[", run: () => moveTo([...starts()].reverse().find((start) => start < cursor()) ?? 0) },
      { id: `${PLUGIN_ID}.file.next`, title: "Next file", bind: "n,alt+down", run: () => selectFile(fileIndex() + 1) },
      { id: `${PLUGIN_ID}.file.previous`, title: "Previous file", bind: "p,alt+up", run: () => selectFile(fileIndex() - 1) },
      { id: `${PLUGIN_ID}.comment`, title: "Comment on the line or range", bind: "c,return", run: startComment },
      { id: `${PLUGIN_ID}.range`, title: "Start or clear a range", bind: "v", run: () => setMark((current) => current === undefined ? cursor() : undefined) },
      { id: `${PLUGIN_ID}.delete`, title: "Delete the draft here", bind: "x", run: () => {
        const comment = atCursor()
        if (comment && !comment.sent) void review.removeComment(sessionID(), comment.id)
      } },
      { id: `${PLUGIN_ID}.viewed`, title: "Mark the file viewed", bind: "m", run: toggleFileViewed },
      { id: `${PLUGIN_ID}.options`, title: "Review options", bind: "o", run: () => void openOptions() },
      { id: `${PLUGIN_ID}.files`, title: "Toggle the file list", bind: "b", run: () => setListShown((shown) => !shown) },
      { id: `${PLUGIN_ID}.fullscreen`, title: "Toggle full screen", bind: "f", run: () => props.panel.toggleFullscreen() },
      { id: `${PLUGIN_ID}.refresh`, title: "Refresh", bind: "r", run: () => void reads.refresh() },
      { id: `${PLUGIN_ID}.send`, title: "Send the drafts to the agent", bind: "shift+s", run: send },
      // Leaving sends what you wrote, like submitting a review. It never reaches the host's escape, which interrupts the agent.
      { id: `${PLUGIN_ID}.leave`, title: "Send the drafts and close", bind: "escape", run: () => {
        if (hasUnsent()) send()
        props.panel.close()
      } },
      { id: `${PLUGIN_ID}.close`, title: "Close, keeping the drafts", bind: "q", run: () => props.panel.close() },
    ],
  }))
  api.keymap.layer(() => ({
    enabled: () => props.panel.focused && !!editing(),
    commands: [{ id: `${PLUGIN_ID}.editor.save`, title: "Save the comment", bind: "escape", run: saveEditor }],
  }))

  // Keep the cursor's row on screen, after the frame that lays it out.
  const boxes = new Map<number, BoxRenderable>()
  createEffect(on([cursor, parts, editAt], () => {
    const follow = () => {
      if (!scroll || scroll.isDestroyed) return
      const index = editAt() ?? cursor()
      const part = parts().find((candidate) => index >= candidate.start && index < candidate.start + candidate.rows.length)
      const box = part && boxes.get(part.start)
      if (!part || !box) return
      // The first line also reveals what's above it, such as comments no longer in the diff.
      if (index === 0 && editAt() === undefined) return scroll.scrollTo(0)
      const top = box.y + (index - part.start) - scroll.viewport.y
      // An open comment box sits below its line: the heading and up to 8 lines of text, under any cards already there.
      const bottom = top + (editAt() === undefined ? 1 : 12)
      if (top < 1) scroll.scrollBy(top - 1)
      else if (bottom > scroll.viewport.height - 1) scroll.scrollBy(bottom - scroll.viewport.height + 1)
    }
    follow()
    api.renderer.once(CliRenderEvents.FRAME, follow)
    api.renderer.requestRender()
    onCleanup(() => { api.renderer.off(CliRenderEvents.FRAME, follow) })
  }))

  const colors = () => api.theme.diff
  const gutter = (row: number) => {
    const span = range()
    if (row === cursor()) return { glyph: "▶", fg: palette.accent }
    if (span && span.from <= row && row <= span.to) return { glyph: "┃", fg: palette.accent }
    if (commented().has(row)) return { glyph: "●", fg: palette.warning }
    return { glyph: " ", fg: palette.muted }
  }
  const draftCount = () => drafts(state()).length
  const status = () => {
    const parts = [`${files().length} ${files().length === 1 ? "file" : "files"}`]
    if (draftCount()) parts.push(`${draftCount()} ${draftCount() === 1 ? "draft" : "drafts"}`)
    if (api.data.session.status(sessionID()) === "running") parts.push("agent working")
    if (diff().loading) parts.push("refreshing")
    return parts.join(" · ")
  }

  return (
    <box width="100%" height="100%" flexDirection="column" minWidth={0} minHeight={0} paddingX={1} backgroundColor={palette.background}>
      <box flexDirection="row" flexShrink={0} minWidth={0} gap={1}>
        <text fg={palette.text} wrapMode="none" flexShrink={0}><b>Review</b> <span style={{ fg: palette.accent }}>{view()}</span></text>
        <text fg={palette.muted} wrapMode="none" minWidth={0} flexShrink={1} flexGrow={1}>{status()}</text>
        <box flexShrink={0} onMouseDown={() => void openOptions()}><text fg={palette.muted} wrapMode="none">[<span style={{ fg: palette.text }}>o</span> options]</text></box>
      </box>
      <Show when={diff().error}>{(error) => <text fg={palette.error} wrapMode="word" flexShrink={0}>! {error()}</text>}</Show>
      <box flexDirection="row" flexGrow={1} minHeight={0} minWidth={0} gap={1}>
        <Show when={wide() && files().length}>
          <FileList files={ordered()} selected={file()?.file} style={review.settings().fileList} width={Math.min(44, Math.max(28, Math.floor(props.panel.width * 0.3)))}
            viewed={viewed} onSelect={(path) => selectFile(ordered().findIndex((entry) => entry.file === path))} />
        </Show>
        <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
          <Show when={file()} fallback={<text fg={palette.muted} wrapMode="word">{diff().value ? `Nothing changed in ${view().toLowerCase()}. Press o to review something else.` : "Loading changes..."}</text>}>
            {(entry) => (
              <text fg={palette.text} wrapMode="none" flexShrink={0}>
                <span style={{ fg: palette.muted }}>{fileIndex() + 1}/{files().length} </span><b>{text.shorten(entry().file, Math.max(10, props.panel.width - 30))}</b> <span style={{ fg: palette.success }}>+{entry().additions}</span> <span style={{ fg: palette.error }}>-{entry().deletions}</span>
                <span style={{ fg: palette.muted }}>{viewed(entry()) ? "  viewed" : ""}</span>
              </text>
            )}
          </Show>
          <scrollbox ref={(element: ScrollBoxRenderable) => { scroll = element }} flexGrow={1} minHeight={0}>
            <Show when={placed().some(({ at }) => !at)}>
              <box flexDirection="column" marginBottom={1}>
                <text fg={palette.muted}>Not in this diff any more:</text>
                <For each={placed().filter(({ at }) => !at)}>{({ comment }) => <CommentCard comment={comment} delivery={deliveries().get(comment.id) ?? "draft"} reply={replies()[comment.id]} quote />}</For>
              </box>
            </Show>
            <For each={parts()}>{(part) => {
              const end = part.start + part.rows.length - 1
              onCleanup(() => boxes.delete(part.start))
              let box: BoxRenderable | undefined
              return (
                <box flexDirection="column" minWidth={0}>
                  <Show when={part.start > 0 && rows()[part.start - 1]!.hunk !== part.rows[0]!.hunk}>
                    <text fg={colors().text.hunkHeader}>  ⋯</text>
                  </Show>
                  <box ref={(element: BoxRenderable) => { box = element; boxes.set(part.start, element) }} flexDirection="row" minWidth={0}
                    onMouseDown={(event) => { if (box) moveTo(part.start + event.y - box.y) }}>
                    <text width={1} flexShrink={0} wrapMode="none">
                      <For each={part.rows}>{(_, offset) => <span style={{ fg: gutter(part.start + offset()).fg }}>{gutter(part.start + offset()).glyph + (offset() < part.rows.length - 1 ? "\n" : "")}</span>}</For>
                    </text>
                    <diff diff={part.patch} view="unified" filetype={pathToFiletype(file()?.file ?? "")} syntaxStyle={props.syntax?.()} wrapMode="none" showLineNumbers
                      flexGrow={1} minWidth={0} fg={colors().text.context}
                      addedBg={colors().background.added} removedBg={colors().background.removed} contextBg={colors().background.context}
                      addedSignColor={colors().text.added} removedSignColor={colors().text.removed} lineNumberFg={colors().lineNumber.text}
                      addedLineNumberBg={colors().lineNumber.background.added} removedLineNumberBg={colors().lineNumber.background.removed} />
                  </box>
                  <For each={placed().filter(({ at }) => at?.to === end)}>{({ comment }) => <CommentCard comment={comment} delivery={deliveries().get(comment.id) ?? "draft"} reply={replies()[comment.id]} />}</For>
                  <Show when={editAt() === end && editing()}>{(edit) => (
                    <Editor anchor={edit().anchor} id={edit().id} text={edit().text} ref={(element) => { editor = element }} onSubmit={saveEditor}
                      onChange={(body) => {
                        // A change event can trail the save that closed the editor; it must not reopen it.
                        const current = editing()
                        if (current) place({ editing: { ...current, text: body } })
                      }} />
                  )}</Show>
                </box>
              )
            }}</For>
          </scrollbox>
        </box>
      </box>
      <box flexShrink={0} minWidth={0}>
        <Show when={editing()} fallback={
          <KeyHints items={[
            { key: "c", label: "comment", command: `${PLUGIN_ID}.comment` },
            { key: "v", label: mark() === undefined ? "range" : "end range", command: `${PLUGIN_ID}.range` },
            { key: "S", label: hasUnsent() ? `send ${draftCount() || ""}`.trim() : "send", command: `${PLUGIN_ID}.send` },
            { key: "m", label: "viewed", command: `${PLUGIN_ID}.viewed` },
            { key: "o", label: "options", command: `${PLUGIN_ID}.options` },
            { key: "n/p", label: "file" },
            { key: "esc", label: hasUnsent() ? "send & close" : "close", command: `${PLUGIN_ID}.leave` },
          ]} />
        }>
          <KeyHints items={[{ key: "enter", label: "save" }, { key: "shift+enter", label: "newline" }, { key: "esc", label: "save & close", command: `${PLUGIN_ID}.editor.save` }, { key: "??", label: "asks a question" }]} />
        </Show>
      </box>
    </box>
  )
}

const where = (anchor: Anchor) => `${anchor.side === "old" ? "removed " : ""}line ${lineRange(anchor)}`

function CommentCard(props: { comment: Comment; delivery: Delivery; reply?: Reply; quote?: boolean }) {
  const palette = usePalette()
  const replyColor = () => props.reply?.status === "done" ? palette.success : props.reply?.status === "declined" ? palette.warning : palette.value
  return (
    <box flexDirection="column" minWidth={0} marginLeft={2} marginY={0} paddingX={1} border={["left"]} borderColor={props.comment.sent ? palette.border : palette.accent}>
      <text fg={palette.muted} wrapMode="none">
        <span style={{ fg: palette.accent }}>{props.comment.id}</span> {where(props.comment)}{isQuestion(props.comment.text) ? " · question" : ""} · {deliveryLabel[props.delivery]}
      </text>
      <Show when={props.quote}><text fg={palette.muted} wrapMode="none">{props.comment.quote.slice(0, 2).join("\n")}</text></Show>
      <text fg={palette.text} wrapMode="word">{props.comment.text}</text>
      <Show when={props.reply}>{(reply) => <text fg={replyColor()} wrapMode="word">↳ {reply().status}: {reply().reply}</text>}</Show>
    </box>
  )
}

function Editor(props: { anchor: Anchor; id?: string; text: string; ref: (element: TextareaRenderable | undefined) => void; onSubmit: () => void; onChange: (text: string) => void }): JSX.Element {
  const palette = usePalette()
  let element: TextareaRenderable | undefined
  onMount(() => {
    element?.focus()
    element?.gotoBufferEnd()
  })
  onCleanup(() => props.ref(undefined))
  return (
    <box flexDirection="column" minWidth={0} marginLeft={2} paddingX={1} border={["left"]} borderColor={palette.accent}>
      <text fg={palette.muted} wrapMode="none">{props.id ? `Editing ${props.id}` : "New comment"} on {where(props.anchor)}</text>
      <textarea ref={(textarea: TextareaRenderable) => { element = textarea; props.ref(textarea) }} initialValue={props.text} minHeight={1} maxHeight={8}
        placeholder="Ask or adjust. End with ?? for a question." textColor={palette.text} focusedTextColor={palette.text} placeholderColor={palette.muted}
        keyBindings={[
          { name: "return", action: "submit" },
          { name: "return", shift: true, action: "newline" },
          { name: "return", meta: true, action: "newline" },
          { name: "linefeed", action: "newline" },
        ]}
        onSubmit={props.onSubmit} onContentChange={() => props.onChange(element?.plainText ?? "")} />
    </box>
  )
}
