/** @jsxImportSource @opentui/solid */

import { errorMessage } from "@opcode/core"
import { createRefresh, type RefreshState } from "@opcode/core/refresh"
import { KeyHints, usePalette, useText, type KeyHint } from "@opcode/ui"
import type { FileDiffInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { CliRenderEvents, type BoxRenderable, type ScrollBoxRenderable, type SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import type { Cursor, Frame, Position, ReviewController } from "./host"
import { CommentsView } from "./comments"
import { frameFor, frameID, trail } from "./frames"
import { searchDiff, type Match } from "./matches"
import { SearchResults } from "./results"
import { FILE_RADIUS, filePatch, hunkStarts, lineOf, parsePatch, segments, shownLines, type Segment } from "./patch"
import type { Lookup, Place } from "./references"
import { arrangeReferences, scopes } from "./usages"
import { ReferencesView } from "./places"
import { DiffRows } from "./segment"
import {
  anchorOf, drafts, isQuestion, lineRange, locate, modes, modeTitle, nearestRow, placeComments, PLUGIN_ID,
  type Anchor, type Comment, type Delivery, type FileList as FileListStyle, type Mode, type ReferenceEngine, type Reply,
} from "./review"
import { FileList } from "./files"
import { listBranches, loadDiff } from "./source"
import { defaultToken, identifiers } from "./symbols"
import { treeOrder } from "./tree"

/** From this width the file list sits beside the diff; a narrower panel shows a few rows of it above. */
const SIDE_WIDTH = 100
/** How tall the file list above the diff grows at most. */
const TOP_ROWS = 8

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

type RefsFrame = Extract<Frame, { kind: "refs" }>
type SearchFrame = Extract<Frame, { kind: "search" }>
type CommentsFrame = Extract<Frame, { kind: "comments" }>

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
  /** The file picked in the diff, under any views opened from it. */
  const file = createMemo(() => files().find((entry) => entry.file === position().file) ?? ordered()[0])
  const fileIndex = () => Math.max(0, ordered().findIndex((entry) => entry.file === file()?.file))
  const viewed = (entry: FileDiffInfo) => review.isViewed(sessionID(), mode(), entry.file, entry.patch)
  const replies = () => review.repliesFor(sessionID())

  // Views opened from the diff: usages, a diff row jumped to, or a file the diff doesn't show. Escape pops one.
  const stack = () => position().stack ?? []
  const top = () => stack().at(-1)
  const setStack = (next: readonly Frame[]) => place({ stack: next })
  const setTop = (change: Partial<Frame>) => setStack([...stack().slice(0, -1), { ...stack().at(-1)!, ...change } as Frame])
  const push = (frame: Frame) => {
    saveEditor()
    setCommentOn(undefined)
    setStack([...stack(), frame])
  }
  const pop = () => {
    saveEditor()
    setCommentOn(undefined)
    setStack(stack().slice(0, -1))
  }

  /** What the cursor moves through: a file of the diff, or a file opened read-only around a usage. */
  const doc = createMemo(() => {
    const frame = top()
    if (frame?.kind === "file") return { file: frame.file, patch: frame.content === undefined ? "" : filePatch(frame.content, frame.center), outside: true }
    if (frame?.kind === "refs" || frame?.kind === "search" || frame?.kind === "comments") return undefined
    const name = frame?.kind === "diff" ? frame.file : file()?.file
    const entry = files().find((candidate) => candidate.file === name)
    return entry && { file: entry.file, patch: entry.patch, outside: false }
  })
  // Every refresh brings new objects; only a changed patch re-parses, so an unchanged diff (and a comment being typed) stays mounted.
  const patchText = createMemo(() => doc()?.patch ?? "")
  const rows = createMemo(() => parsePatch(patchText()))
  const docFile = () => doc()?.file

  /** The cursor of the document shown: the diff's, or the open view's own. */
  const here = (): Cursor => {
    const frame = top()
    return frame?.kind === "diff" || frame?.kind === "file" ? frame : position()
  }
  const setHere = (change: Partial<Cursor>) => {
    const frame = top()
    if (frame?.kind === "diff" || frame?.kind === "file") setTop(change)
    else place(change)
  }
  // The cursor is a line and its text, not a row index, so a refresh that adds rows above it doesn't move it.
  const cursor = createMemo(() => nearestRow(rows(), here().line, here().old, here().text))
  const moveTo = (index: number) => {
    const row = rows()[Math.max(0, Math.min(rows().length - 1, index))]
    if (!row) return
    const frame = top()
    // A file view shows a stretch of the file; it moves along once the cursor nears an edge.
    const recenter = frame?.kind === "file" && Math.abs(lineOf(row) - frame.center) > FILE_RADIUS - 10 ? { center: lineOf(row) } : {}
    setHere({ ...frame ? recenter : { file: docFile() }, line: lineOf(row), old: row.kind === "del", text: row.text, token: undefined })
  }
  const [mark, setMark] = createSignal<number>()
  // A range belongs to one document of one session. A memo, so moving the cursor (which rewrites the position) keeps it.
  const markScope = createMemo(() => `${sessionID()}:${top()?.id ?? "diff"}:${docFile()}`)
  createEffect(on(markScope, () => setMark(undefined), { defer: true }))
  const selectFile = (index: number) => {
    saveEditor()
    setCommentOn(undefined)
    const next = ordered()[Math.max(0, Math.min(ordered().length - 1, index))]
    if (next) place({ file: next.file, line: undefined, old: undefined, text: undefined, token: undefined, stack: [] })
  }

  // The symbol on the cursor row that usages and definitions are for.
  const tokens = createMemo(() => {
    const row = rows()[cursor()]
    return row && docFile() ? identifiers(row.text, docFile()!) : []
  })
  const token = createMemo(() => {
    const list = tokens()
    if (!list.length) return undefined
    const picked = here().token
    return picked !== undefined && picked < list.length ? picked : Math.min(list.length - 1, defaultToken(rows()[cursor()]!, rows(), docFile()!))
  })
  const pickedToken = () => { const at = token(); return at === undefined ? undefined : tokens()[at] }
  /** The picked name, marked wherever it appears in the file being read. */
  const pickedName = () => editing() ? undefined : pickedToken()?.name
  const stepToken = (by: number) => {
    const at = token()
    if (at !== undefined) setHere({ token: Math.max(0, Math.min(tokens().length - 1, at + by)) })
  }

  const comments = createMemo(() => state().comments.filter((comment) => comment.file === docFile()))
  const placed = createMemo(() => placeComments(comments(), rows()))
  const deliveries = () => review.deliveries(sessionID())
  // Drafts whose text the agent moved take their new lines, which the message and the card show.
  createEffect(on(placed, (list) => {
    const name = docFile()
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
    if (!edit || edit.anchor.file !== docFile()) return undefined
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
      const { file, side, start, end, quote, outside } = existing
      place({ editing: { id: existing.id, anchor: { file, side, start, end, quote: [...quote], ...outside ? { outside } : {} }, text: existing.text } })
      return
    }
    const current = doc()
    if (!current || !rows().length) return
    const span = range() ?? { from: cursor(), to: cursor() }
    place({ editing: { anchor: { ...anchorOf(current.file, rows(), span.from, span.to), ...current.outside ? { outside: true } : {} }, text: "" } })
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
  // A comment whose document left the view (the agent reverted the file) is saved rather than left without a box.
  createEffect(() => { if (editing() && diff().value && doc() && rows().length && editing()!.anchor.file !== docFile()) saveEditor() })

  // A file opened from a usage is read once, from the session's directory on the server.
  createEffect(on(() => {
    const frame = top()
    return frame?.kind === "file" && frame.content === undefined && !frame.error ? frame.file : undefined
  }, (path) => {
    const directory = review.directory(sessionID())
    if (!path || !directory) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    api.client.file.read({ path, location: { directory } }, { signal: controller.signal }).then(
      (bytes) => { if (!controller.signal.aborted && top()?.kind === "file") setTop({ content: new TextDecoder().decode(bytes) }) },
      (error) => { if (!controller.signal.aborted && top()?.kind === "file") setTop({ error: errorMessage(error) }) },
    )
  }))

  // A file the agent changes on disk is read again. Paths in the event may be absolute.
  stops.push(api.data.on("filesystem.changed", (event) => {
    const frame = top()
    const changed = event.data.file.replaceAll("\\", "/")
    if (frame?.kind === "file" && frame.content !== undefined && (changed === frame.file || changed.endsWith(`/${frame.file}`))) setTop({ content: undefined, error: undefined })
  }))
  // A diff row jumped to whose file the diff no longer shows becomes a read-only view of the file.
  createEffect(() => {
    const frame = top()
    if (frame?.kind === "diff" && diff().value && !files().some((entry) => entry.file === frame.file)) setTop({ kind: "file", center: frame.line ?? 1 } as Partial<Frame>)
  })

  // Each changed file's rows, parsed once per refresh, for jumping to lines and searching them.
  const parsed = createMemo(() => new Map(files().map((entry) => [entry.file, parsePatch(entry.patch)])))
  const shown = createMemo(() => new Map([...parsed()].map(([path, fileRows]) => [path, shownLines(fileRows)])))
  /** Opens a place: on its diff row when the diff shows the line, else in a read-only view of its file. */
  const openPlace = (target: Place, replace = false) => {
    const frame = frameFor(target, (path) => shown().get(path), frameID())
    if (replace) setStack([...stack().slice(0, -1), frame])
    else push(frame)
    return frame.id
  }
  // c on a usage opens it and starts a comment there, once that view's lines are in.
  const [commentOn, setCommentOn] = createSignal<number>()
  createEffect(() => {
    const pending = commentOn()
    if (pending === undefined || top()?.id !== pending || !rows().length) return
    setCommentOn(undefined)
    startComment()
  })

  /** The symbol under the cursor, and whether only a search can find it: a removed line isn't in any file a language server reads. */
  const lookup = (): { lookup: Lookup; searchOnly: boolean } | undefined => {
    const row = rows()[cursor()]
    const at = token()
    const picked = at === undefined ? undefined : tokens()[at]
    if (!row || !picked || !docFile()) return undefined
    return { lookup: { file: docFile()!, line: row.kind === "del" ? row.newAt : row.new!, column: picked.start, name: picked.name }, searchOnly: row.kind === "del" }
  }
  const find = (kind: "usages" | "definition", from = lookup()) => {
    if (!from) return api.ui.toast.show({ title: "Review", message: "No name on this line to look up." })
    push({ id: frameID(), kind: "refs", query: kind, lookup: from.lookup, searchOnly: from.searchOnly, scope: "all", selected: 0 })
  }
  // An unanswered list on top is looked up, also after reopening the panel or coming back to it. The answer goes to
  // the frame that asked, by ID, in the session that asked, wherever that frame is by then.
  createEffect(on(() => {
    const frame = top()
    return frame?.kind === "refs" && !frame.found && !frame.error ? frame.id : undefined
  }, (id) => {
    const frame = top()
    if (id === undefined || frame?.kind !== "refs") return
    const session = sessionID()
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    review.findSymbols(session, frame.query, frame.lookup, controller.signal, frame.searchOnly).then((found) => {
      if (controller.signal.aborted) return
      // A single definition opens directly; any other answer is a list to choose from.
      const only = frame.query === "definition" && found.places.length === 1 ? found.places[0]! : undefined
      review.updateFrame(session, id, (current) => only ? frameFor(only, (path) => shown().get(path), current.id) : { ...current, found } as Frame)
    }, (error) => { if (!controller.signal.aborted) review.updateFrame(session, id, (current) => ({ ...current, error: errorMessage(error) }) as Frame) })
  }))
  const refsFrame = () => {
    const frame = top()
    return frame?.kind === "refs" ? frame : undefined
  }
  const listFor = (frame: RefsFrame) => frame.found
    ? arrangeReferences(frame.lookup.name, frame.found.places, files(), { scope: frame.scope, current: frame.lookup.file, partial: frame.found.partial })
    : undefined
  // Moving the selection rewrites the frame; the list stays the same unless the answer, the scope, or the diff changed.
  const listKey = createMemo(() => {
    const frame = refsFrame()
    return frame?.found ? { frame, found: frame.found, scope: frame.scope, files: files() } : undefined
  }, undefined, { equals: (a, b) => a?.found === b?.found && a?.scope === b?.scope && a?.files === b?.files })
  const references = createMemo(() => { const key = listKey(); return key && listFor(key.frame) })
  const flatReferences = () => references()?.listed ?? []
  const selectReference = (index: number) => setTop({ selected: Math.max(0, Math.min(flatReferences().length - 1, index)) } as Partial<RefsFrame>)
  const openSelected = () => {
    const chosen = flatReferences()[refsFrame()?.selected ?? 0]
    if (chosen) openPlace(chosen)
  }
  /** From a usage or match opened out of its list, the next or previous one in its place. */
  const stepResult = (by: number) => {
    const parent = stack().at(-2)
    if (parent?.kind === "search") {
      const matches = searchFor(parent.query).matches
      const index = Math.max(0, Math.min(matches.length - 1, parent.selected + by))
      saveEditor()
      setStack([...stack().slice(0, -2), { ...parent, selected: index, typing: false }])
      openMatch(matches[index])
      return true
    }
    if (parent?.kind !== "refs") return false
    const flat = listFor(parent)?.listed ?? []
    const index = Math.max(0, Math.min(flat.length - 1, parent.selected + by))
    const next = flat[index]
    if (!next) return true
    saveEditor()
    setStack([...stack().slice(0, -2), { ...parent, selected: index }])
    openPlace(next)
    return true
  }

  // Searching the diff: files by path and lines by text, in the order the file list shows them.
  const searchFrame = () => {
    const frame = top()
    return frame?.kind === "search" ? frame : undefined
  }
  const typing = () => !!searchFrame()?.typing
  const searchFor = (query: string) => searchDiff(query, ordered().map((entry) => ({ file: entry.file, rows: parsed().get(entry.file) ?? [] })))
  const found = createMemo(() => searchFor(searchFrame()?.query ?? ""))
  const openSearch = () => {
    const frame = searchFrame()
    if (frame) setTop({ typing: true } as Partial<SearchFrame>)
    else push({ id: frameID(), kind: "search", query: "", typing: true, selected: 0 })
  }
  const selectMatch = (index: number) => setTop({ selected: Math.max(0, Math.min(found().matches.length - 1, index)) } as Partial<SearchFrame>)
  /** A match opens on its diff row, or a matched file at its start; escape comes back to the results. */
  const openMatch = (match: Match | undefined, replace = false) => {
    if (!match) return
    const frame: Frame = match.kind === "file"
      ? { id: frameID(), kind: "diff", file: match.file }
      : { id: frameID(), kind: "diff", file: match.file, line: match.line, old: match.old, text: match.text }
    if (replace) return setStack([...stack().slice(0, -1), frame])
    // Coming back finds the results to browse, not the box still taking keys.
    if (searchFrame()?.typing) setTop({ typing: false } as Partial<SearchFrame>)
    push(frame)
  }

  // Every comment of the session in one place, with the agent's replies.
  const commentsFrame = () => {
    const frame = top()
    return frame?.kind === "comments" ? frame : undefined
  }
  const allComments = () => state().comments
  const unseen = createMemo(() => review.unseen(sessionID()))
  /** The replies that were new when the view opened stay marked while it's open. */
  const [fresh, setFresh] = createSignal<ReadonlySet<string>>(new Set())
  const openComments = () => {
    if (commentsFrame()) return
    setFresh(new Set(unseen()))
    void review.markSeen(sessionID())
    push({ id: frameID(), kind: "comments", selected: 0 })
  }
  const selectComment = (index: number) => setTop({ selected: Math.max(0, Math.min(allComments().length - 1, index)) } as Partial<CommentsFrame>)
  /** Opens a comment where it is: its diff row when the diff still shows its lines, else its file around them. */
  const openComment = (comment: Comment | undefined) => {
    if (!comment) return
    const fileRows = comment.outside ? undefined : parsed().get(comment.file)
    const at = fileRows && locate(comment, fileRows)
    const row = at && fileRows[at.from]
    push(row
      ? { id: frameID(), kind: "diff", file: comment.file, line: lineOf(row), old: row.kind === "del", text: row.text }
      : { id: frameID(), kind: "file", file: comment.file, line: comment.start, center: comment.start })
  }

  const send = () => void review.send(sessionID(), view())
  const hasUnsent = () => review.hasUnsent(sessionID())
  /** What to review, how to list the files, and how to find usages, in one menu. */
  const openOptions = async () => {
    // What's in effect is checked in the title, so it reads at a glance however narrow the menu is.
    const checked = (on: boolean, title: string) => on ? `✓ ${title}` : `  ${title}`
    const choice = await api.ui.dialog.select<Mode | "base" | FileListStyle | `refs:${ReferenceEngine}`>({
      title: "Review options",
      current: mode(),
      options: [
        ...modes.map((value) => ({ title: checked(value === mode(), modeTitle[value]), value, description: describe[value], category: "View" })),
        { title: "  Base branch...", value: "base" as const, description: state().base ? `Comparing against ${state().base}` : "Pick what the branch view compares against", category: "View" },
        { title: checked(review.settings().fileList === "tree", "Folder tree"), value: "tree" as const, description: "Files under their folders", category: "File list" },
        { title: checked(review.settings().fileList === "paths", "Full paths"), value: "paths" as const, description: "Each file's whole path", category: "File list" },
        { title: checked(review.settings().references === "lsp", "Language server, then search"), value: "refs:lsp" as const, description: "The language server OpenCode is set up with for the file, else a search by name", category: "Usages and definitions" },
        { title: checked(review.settings().references === "search", "Search only"), value: "refs:search" as const, description: "A whole-word search for the name, without starting a language server", category: "Usages and definitions" },
      ],
    })
    if (choice === "base") return chooseBase()
    if (choice === "tree" || choice === "paths") return void review.updateSettings({ fileList: choice })
    if (choice === "refs:lsp" || choice === "refs:search") return void review.updateSettings({ references: choice === "refs:lsp" ? "lsp" : "search" })
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
    if (next) place({ file: next.file, line: undefined, old: undefined, text: undefined, token: undefined })
  }

  let scroll: ScrollBoxRenderable | undefined
  const page = () => Math.max(1, Math.floor((scroll?.viewport.height ?? 20) / 2))
  const starts = createMemo(() => hunkStarts(rows()))
  const [listShown, setListShown] = createSignal(true)
  const [keysShown, setKeysShown] = createSignal(true)
  /** The host's binding for a command, arrows drawn as arrows. */
  const shortcut = (id: string) => api.keymap.shortcuts(id)[0]?.replace(/\bleft\b/, "←").replace(/\bright\b/, "→")
  const focusPrompt = () => shortcut("pane.focus.left")
  const focusPanel = () => shortcut("pane.focus.right")
  /** Where the file list goes: beside the diff, above it, or nowhere when hidden or empty. */
  const listAt = () => !listShown() || !files().length ? undefined : props.panel.width >= SIDE_WIDTH ? "side" : "top"
  const inList = () => !!refsFrame() || !!searchFrame() || !!commentsFrame()
  const back = () => { if (stack().length) pop() }

  // The host scopes a panel's layers to when it owns input; checking focus too keeps a prompt you're typing in safe.
  api.keymap.layer(() => ({
    enabled: () => props.panel.focused && !editing() && !inList(),
    commands: [
      { id: `${PLUGIN_ID}.down`, title: "Next line", bind: "j,down", run: () => moveTo(cursor() + 1) },
      { id: `${PLUGIN_ID}.up`, title: "Previous line", bind: "k,up", run: () => moveTo(cursor() - 1) },
      { id: `${PLUGIN_ID}.page.down`, title: "Half a page down", bind: "ctrl+d,pagedown", run: () => moveTo(cursor() + page()) },
      { id: `${PLUGIN_ID}.page.up`, title: "Half a page up", bind: "ctrl+u,pageup", run: () => moveTo(cursor() - page()) },
      { id: `${PLUGIN_ID}.first`, title: "First line", bind: "g,home", run: () => moveTo(0) },
      { id: `${PLUGIN_ID}.last`, title: "Last line", bind: "shift+g,end", run: () => moveTo(rows().length - 1) },
      { id: `${PLUGIN_ID}.hunk.next`, title: "Next hunk", bind: "]", run: () => moveTo(starts().find((start) => start > cursor()) ?? cursor()) },
      { id: `${PLUGIN_ID}.hunk.previous`, title: "Previous hunk", bind: "[", run: () => moveTo([...starts()].reverse().find((start) => start < cursor()) ?? 0) },
      { id: `${PLUGIN_ID}.file.next`, title: "Next file", bind: "shift+j,alt+down", run: () => selectFile(fileIndex() + 1) },
      { id: `${PLUGIN_ID}.file.previous`, title: "Previous file", bind: "shift+k,alt+up", run: () => selectFile(fileIndex() - 1) },
      // Opened from a list of usages or matches, the next or previous one in its place.
      { id: `${PLUGIN_ID}.result.next`, title: "Next usage or match", bind: "n", enabled: () => stack().at(-2)?.kind === "refs" || stack().at(-2)?.kind === "search", run: () => stepResult(1) },
      { id: `${PLUGIN_ID}.result.previous`, title: "Previous usage or match", bind: "p", enabled: () => stack().at(-2)?.kind === "refs" || stack().at(-2)?.kind === "search", run: () => stepResult(-1) },
      { id: `${PLUGIN_ID}.symbol.previous`, title: "Previous name on the line", bind: "h,left", run: () => stepToken(-1) },
      { id: `${PLUGIN_ID}.symbol.next`, title: "Next name on the line", bind: "l,right", run: () => stepToken(1) },
      { id: `${PLUGIN_ID}.usages`, title: "Usages of the name", bind: "u", run: () => find("usages") },
      { id: `${PLUGIN_ID}.search`, title: "Search the diff's files and lines", bind: "/", run: openSearch },
      { id: `${PLUGIN_ID}.definition`, title: "Definition of the name", bind: "d", run: () => find("definition") },
      { id: `${PLUGIN_ID}.comment`, title: "Comment on the line or range", bind: "c,return", run: startComment },
      { id: `${PLUGIN_ID}.range`, title: "Start or clear a range", bind: "v", run: () => setMark((current) => current === undefined ? cursor() : undefined) },
      { id: `${PLUGIN_ID}.delete`, title: "Delete the draft here", bind: "x", run: () => {
        const comment = atCursor()
        if (comment && !comment.sent) void review.removeComment(sessionID(), comment.id)
      } },
      { id: `${PLUGIN_ID}.viewed`, title: "Mark the file viewed", bind: "m", enabled: () => !stack().length, run: toggleFileViewed },
      { id: `${PLUGIN_ID}.back`, title: "Back", bind: "ctrl+o", enabled: () => stack().length > 0, run: back },
      // Leaving sends what you wrote, like submitting a review. It never reaches the host's escape, which interrupts the agent.
      // Inside a view opened from the diff, escape goes back instead.
      { id: `${PLUGIN_ID}.leave`, title: "Back, or send the drafts and close", bind: "escape", run: () => {
        if (stack().length) return pop()
        if (hasUnsent()) send()
        props.panel.close()
      } },
    ],
  }))
  api.keymap.layer(() => ({
    enabled: () => props.panel.focused && !editing() && !!refsFrame(),
    commands: [
      { id: `${PLUGIN_ID}.list.down`, title: "Next place", bind: "j,down,n", run: () => selectReference((refsFrame()?.selected ?? 0) + 1) },
      { id: `${PLUGIN_ID}.list.up`, title: "Previous place", bind: "k,up,p", run: () => selectReference((refsFrame()?.selected ?? 0) - 1) },
      { id: `${PLUGIN_ID}.list.open`, title: "Open the place", bind: "return", run: openSelected },
      { id: `${PLUGIN_ID}.list.comment`, title: "Comment on the place", bind: "c", run: () => {
        if (!flatReferences().length) return
        const chosen = flatReferences()[refsFrame()?.selected ?? 0]
        if (chosen) setCommentOn(openPlace(chosen))
      } },
      { id: `${PLUGIN_ID}.list.scope`, title: "All, in the diff, or outside it", bind: "tab", run: () => {
        const frame = refsFrame()
        if (frame) setTop({ scope: scopes[(scopes.indexOf(frame.scope) + 1) % scopes.length], selected: 0 } as Partial<RefsFrame>)
      } },
      { id: `${PLUGIN_ID}.list.definition`, title: "Definition of the name", bind: "d", run: () => {
        const frame = refsFrame()
        if (frame) find("definition", { lookup: frame.lookup, searchOnly: frame.searchOnly })
      } },
      { id: `${PLUGIN_ID}.list.back`, title: "Back", bind: "escape,ctrl+o", run: pop },
    ],
  }))
  api.keymap.layer(() => ({
    enabled: () => props.panel.focused && !editing() && !!searchFrame(),
    commands: [
      // Up and down browse the results while typing; the letters stay in the box.
      { id: `${PLUGIN_ID}.search.down`, title: "Next match", bind: "down", run: () => selectMatch((searchFrame()?.selected ?? 0) + 1) },
      { id: `${PLUGIN_ID}.search.up`, title: "Previous match", bind: "up", run: () => selectMatch((searchFrame()?.selected ?? 0) - 1) },
      { id: `${PLUGIN_ID}.search.down.vi`, title: "Next match", bind: "j,n", enabled: () => !typing(), run: () => selectMatch((searchFrame()?.selected ?? 0) + 1) },
      { id: `${PLUGIN_ID}.search.up.vi`, title: "Previous match", bind: "k,p", enabled: () => !typing(), run: () => selectMatch((searchFrame()?.selected ?? 0) - 1) },
      { id: `${PLUGIN_ID}.search.open`, title: "Open the match", bind: "return", run: () => openMatch(found().matches[searchFrame()?.selected ?? 0]) },
      { id: `${PLUGIN_ID}.search.type`, title: "Search again", bind: "/", enabled: () => !typing(), run: openSearch },
      // Escape leaves the box with the results kept to browse, then closes the search.
      { id: `${PLUGIN_ID}.search.back`, title: "Done typing, or back", bind: "escape", run: () => {
        if (typing() && searchFrame()?.query) setTop({ typing: false } as Partial<SearchFrame>)
        else pop()
      } },
    ],
  }))
  api.keymap.layer(() => ({
    enabled: () => props.panel.focused && !editing() && !!commentsFrame(),
    commands: [
      { id: `${PLUGIN_ID}.comments.down`, title: "Next comment", bind: "j,down", run: () => selectComment((commentsFrame()?.selected ?? 0) + 1) },
      { id: `${PLUGIN_ID}.comments.up`, title: "Previous comment", bind: "k,up", run: () => selectComment((commentsFrame()?.selected ?? 0) - 1) },
      { id: `${PLUGIN_ID}.comments.open`, title: "Open the comment where it is", bind: "return", run: () => openComment(allComments()[commentsFrame()?.selected ?? 0]) },
      { id: `${PLUGIN_ID}.comments.delete`, title: "Delete the draft", bind: "x", run: () => {
        const comment = allComments()[commentsFrame()?.selected ?? 0]
        if (comment && !comment.sent) void review.removeComment(sessionID(), comment.id).then(() => selectComment(commentsFrame()?.selected ?? 0))
      } },
      { id: `${PLUGIN_ID}.comments.back`, title: "Back", bind: "escape,ctrl+o", run: pop },
    ],
  }))
  // Commands that work in every view, except while typing a search.
  api.keymap.layer(() => ({
    enabled: () => props.panel.focused && !editing() && !typing(),
    commands: [
      { id: `${PLUGIN_ID}.options`, title: "Review options", bind: "o", run: () => void openOptions() },
      { id: `${PLUGIN_ID}.files`, title: "Toggle the file list", bind: "b", run: () => setListShown((shown) => !shown) },
      { id: `${PLUGIN_ID}.fullscreen`, title: "Toggle full screen", bind: "f", run: () => props.panel.toggleFullscreen() },
      { id: `${PLUGIN_ID}.refresh`, title: "Refresh", bind: "r", run: () => void reads.refresh() },
      { id: `${PLUGIN_ID}.send`, title: "Send the drafts to the agent", bind: "shift+s", run: send },
      { id: `${PLUGIN_ID}.close`, title: "Close, keeping the drafts", bind: "q", run: () => props.panel.close() },
      { id: `${PLUGIN_ID}.comments`, title: "All comments and replies", bind: "shift+c", run: openComments },
      { id: `${PLUGIN_ID}.keys`, title: "Show or hide the keys", bind: "shift+/,?", run: () => setKeysShown((shown) => !shown) },
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
  const hints = (): KeyHint[] => {
    if (editing()) return [{ key: "enter", label: "save" }, { key: "shift+enter", label: "newline" }, { key: "esc", label: "save & close", command: `${PLUGIN_ID}.editor.save` }, { key: "??", label: "asks a question" }]
    if (searchFrame()) return typing()
      ? [{ key: "↑/↓", label: "move" }, { key: "enter", label: "open", command: `${PLUGIN_ID}.search.open` }, { key: "esc", label: searchFrame()!.query ? "done" : "back", command: `${PLUGIN_ID}.search.back` }]
      : [{ key: "j/k", label: "move" }, { key: "enter", label: "open", command: `${PLUGIN_ID}.search.open` }, { key: "/", label: "edit", command: `${PLUGIN_ID}.search.type` }, { key: "esc", label: "back", command: `${PLUGIN_ID}.search.back` }]
    if (commentsFrame()) return [
      { key: "j/k", label: "move" },
      { key: "enter", label: "open", command: `${PLUGIN_ID}.comments.open` },
      { key: "x", label: "delete draft", command: `${PLUGIN_ID}.comments.delete` },
      { key: "S", label: "send", command: `${PLUGIN_ID}.send` },
      { key: "esc", label: "back", command: `${PLUGIN_ID}.comments.back` },
    ]
    if (inList()) return [
      { key: "enter", label: "open", command: `${PLUGIN_ID}.list.open` },
      { key: "c", label: "comment", command: `${PLUGIN_ID}.list.comment` },
      { key: "tab", label: "scope", command: `${PLUGIN_ID}.list.scope` },
      { key: "d", label: "definition", command: `${PLUGIN_ID}.list.definition` },
      { key: "esc", label: "back", command: `${PLUGIN_ID}.list.back` },
    ]
    return [
      { key: "c", label: "comment", command: `${PLUGIN_ID}.comment` },
      { key: "v", label: mark() === undefined ? "range" : "end range", command: `${PLUGIN_ID}.range` },
      { key: "u", label: "usages", command: `${PLUGIN_ID}.usages` },
      { key: "d", label: "definition", command: `${PLUGIN_ID}.definition` },
      { key: "/", label: "search", command: `${PLUGIN_ID}.search` },
      ...stack().length ? [] : [{ key: "S", label: hasUnsent() ? `send ${draftCount() || ""}`.trim() : "send", command: `${PLUGIN_ID}.send` }, { key: "m", label: "viewed", command: `${PLUGIN_ID}.viewed` }],
      { key: "o", label: "options", command: `${PLUGIN_ID}.options` },
      { key: "esc", label: stack().length ? "back" : hasUnsent() ? "send & close" : "close", command: `${PLUGIN_ID}.leave` },
    ]
  }

  return (
    <box width="100%" height="100%" flexDirection="column" minWidth={0} minHeight={0} backgroundColor={palette.panel}>
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} paddingX={1} paddingTop={1}>
      <box flexDirection="row" flexShrink={0} minWidth={0} gap={1} marginBottom={1}>
        <text fg={palette.text} wrapMode="none" flexShrink={0}><b>Review</b> <span style={{ fg: palette.accent }}>{view()}</span></text>
        <text fg={palette.muted} wrapMode="none" minWidth={0} flexShrink={1} flexGrow={1}>{status()}</text>
        <box flexShrink={0} onMouseDown={openComments}>
          <text fg={palette.muted} wrapMode="none">
            [<span style={{ fg: palette.text }}>C</span> {allComments().length} {allComments().length === 1 ? "comment" : "comments"}<Show when={unseen().length}><span style={{ fg: palette.accent }}> ● {unseen().length} new</span></Show>]
          </text>
        </box>
        <box flexShrink={0} onMouseDown={() => void openOptions()}><text fg={palette.muted} wrapMode="none">[<span style={{ fg: palette.text }}>o</span> options]</text></box>
      </box>
      <Show when={diff().error}>{(error) => <text fg={palette.error} wrapMode="word" flexShrink={0}>! {error()}</text>}</Show>
      <box flexDirection="row" flexGrow={1} minHeight={0} minWidth={0} gap={1}>
        <Show when={listAt() === "side"}>
          <FileList files={ordered()} selected={file()?.file} style={review.settings().fileList} width={Math.min(44, Math.max(28, Math.floor(props.panel.width * 0.3)))}
            viewed={viewed} onSelect={(path) => selectFile(ordered().findIndex((entry) => entry.file === path))} />
        </Show>
        <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
          <Show when={listAt() === "top"}>
            <box flexShrink={0} marginBottom={1} border={["bottom"]} borderColor={palette.border}>
              <FileList files={ordered()} selected={file()?.file} style={review.settings().fileList} width={props.panel.width - 2} maxRows={TOP_ROWS}
                viewed={viewed} onSelect={(path) => selectFile(ordered().findIndex((entry) => entry.file === path))} />
            </box>
          </Show>
          <Show when={stack().length}>
            <text fg={palette.muted} wrapMode="none" flexShrink={0}>← {text.shorten(trail(stack()), Math.max(10, props.panel.width - 6))}</text>
          </Show>
          <Show when={!commentsFrame()} fallback={
            <CommentsView comments={allComments()} deliveries={deliveries()} replies={replies()} fresh={fresh()} selected={commentsFrame()?.selected ?? 0}
              width={props.panel.width} onSelect={(index) => { selectComment(index); openComment(allComments()[index]) }} />
          }>
          <Show when={!searchFrame()} fallback={
            <SearchResults query={searchFrame()?.query ?? ""} typing={typing()} found={found()} selected={searchFrame()?.selected ?? 0} width={props.panel.width}
              onInput={(query) => setTop({ query, selected: 0 } as Partial<SearchFrame>)} onSubmit={() => openMatch(found().matches[searchFrame()?.selected ?? 0])}
              onSelect={(index) => { selectMatch(index); openMatch(found().matches[index]) }} />
          }>
          <Show when={refsFrame()} fallback={
            <>
              <Show when={top()?.kind === "file" ? top() as Extract<Frame, { kind: "file" }> : undefined} fallback={
                <Show when={file()} fallback={<text fg={palette.muted} wrapMode="word">{diff().value ? `Nothing changed in ${view().toLowerCase()}. Press o to review something else.` : "Loading changes..."}</text>}>
                  {(entry) => (
                    <Show when={!stack().length}>
                      <box flexDirection="row" flexShrink={0} minWidth={0} gap={1}>
                        <text fg={palette.text} wrapMode="none" minWidth={0} flexShrink={1} flexGrow={1}>
                          <span style={{ fg: palette.muted }}>{fileIndex() + 1}/{files().length} </span>{(() => {
                            // The folder steps back so the file's name stands out, as in /diff.
                            const shown = text.shorten(entry().file, Math.max(10, props.panel.width - 24))
                            const slash = shown.lastIndexOf("/") + 1
                            return <><span style={{ fg: palette.muted }}>{shown.slice(0, slash)}</span><b>{shown.slice(slash)}</b></>
                          })()}
                        </text>
                        <text wrapMode="none" flexShrink={0} fg={palette.muted}>
                          {viewed(entry()) ? "viewed  " : ""}<span style={{ fg: palette.success }}>+{entry().additions}</span> <span style={{ fg: palette.error }}>-{entry().deletions}</span>
                        </text>
                      </box>
                    </Show>
                  )}
                </Show>
              }>
                {(frame) => (
                  <text fg={frame().error ? palette.error : palette.muted} wrapMode="word" flexShrink={0}>
                    {frame().error ? `! ${frame().error}` : frame().content === undefined ? `Opening ${frame().file}...` : "Read-only: the diff doesn't show this. Comments here tell the agent it's outside the diff."}
                  </text>
                )}
              </Show>
              <scrollbox ref={(element: ScrollBoxRenderable) => { scroll = element }} flexGrow={1} minHeight={0}>
                <For each={[false, true]}>{(outside) => (
                  // Comments left outside the diff aren't gone from it; they were never in it.
                  <Show when={placed().some(({ comment, at }) => !at && !!comment.outside === outside)}>
                    <box flexDirection="column" marginBottom={1}>
                      <text fg={palette.muted}>{outside ? "Outside the diff:" : "Not in this diff any more:"}</text>
                      <For each={placed().filter(({ comment, at }) => !at && !!comment.outside === outside)}>{({ comment }) => <CommentCard comment={comment} delivery={deliveries().get(comment.id) ?? "draft"} reply={replies()[comment.id]} quote />}</For>
                    </box>
                  </Show>
                )}</For>
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
                        <DiffRows rows={part.rows} file={docFile() ?? ""} syntax={props.syntax?.()} word={pickedName()}
                          cursor={cursor() >= part.start && cursor() <= end ? cursor() - part.start : undefined}
                          picked={cursor() >= part.start && cursor() <= end && pickedToken() ? { line: cursor() - part.start, start: pickedToken()!.start } : undefined} />
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
              <Show when={!editing() && tokens().length}>
                <text wrapMode="none" flexShrink={0} fg={palette.muted}>
                  <span style={{ fg: palette.muted }}>h/l </span>
                  <For each={tokens()}>{(candidate, index) => <span style={index() === token() ? { fg: palette.selectedText, bg: palette.selectedBackground } : { fg: palette.text }}>{` ${candidate.name} `}</span>}</For>
                </text>
              </Show>
            </>
          }>
            {(frame) => (
              <ReferencesView query={frame().query} name={frame().lookup.name} found={frame().found} error={frame().error} list={references()}
                scope={frame().scope} selected={frame().selected} width={props.panel.width} onSelect={(index) => { selectReference(index); openSelected() }} />
            )}
          </Show>
          </Show>
          </Show>
        </box>
      </box>
      <Show when={keysShown()}>
        <box flexShrink={0} minWidth={0} marginTop={1}>
          <KeyHints items={hints()} />
        </box>
      </Show>
    </box>
      {/* How to get back to the conversation, or here, in the host's own binding, as /diff says it. */}
      <box flexDirection="row" flexShrink={0} minWidth={0} paddingX={1} gap={2} backgroundColor={palette.background}>
        <text wrapMode="none" minWidth={0} flexShrink={1} flexGrow={1} fg={palette.muted}>
          <Show when={props.panel.focused ? focusPrompt() : focusPanel()}>{(keys) => <><span style={{ fg: palette.accent }}>{keys()}</span> {props.panel.focused ? "focus prompt" : "focus review"}</>}</Show>
        </text>
        <box flexShrink={0} onMouseDown={() => setKeysShown((shown) => !shown)}>
          <text wrapMode="none" fg={palette.muted}><span style={{ fg: palette.text }}>?</span> {keysShown() ? "hide keys" : "keys"}</text>
        </box>
      </box>
    </box>
  )
}

const where = (anchor: Anchor) => `${anchor.side === "old" ? "removed " : ""}line ${lineRange(anchor)}${anchor.outside ? " (outside the diff)" : ""}`

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
