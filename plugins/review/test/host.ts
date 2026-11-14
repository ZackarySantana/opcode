import { mockTheme } from "@opcode/ui/test-support/host"
import type { FileDiffInfo, ModelInfo, SessionCreateInput, SessionMessageInfo, SessionPromptInput } from "@opencode/client"
import type { Context, KeymapCommand, KeymapLayer, PanelInput } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { createComputed, createSignal, onCleanup, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"

export const SESSION = "ses_review"

const rgba = (hex: string) => RGBA.fromHex(hex)

/** The shared mock theme plus the diff and syntax tokens the panel draws with. */
export function reviewTheme(): Context["theme"] {
  const theme = mockTheme() as unknown as Record<string, any>
  const gray = rgba("#9aa0a6")
  theme.syntax = Object.fromEntries(["comment", "string", "number", "keyword", "type", "function", "operator", "variable", "punctuation"].map((token) => [token, gray]))
  theme.markdown = Object.fromEntries(["heading", "strong", "emphasis", "listItem", "blockQuote", "code", "link", "linkText"].map((token) => [token, gray]))
  theme.categorical = [{ 200: gray }]
  theme.hue.accent[200] = gray
  theme.text.feedback.info = { base: gray }
  theme.text.action.primary.focused = gray
  theme.background.raised.high = rgba("#2c2d2e")
  theme.background.raised.max = rgba("#343536")
  theme.diff = {
    text: { added: rgba("#77cc88"), removed: rgba("#ee6666"), context: rgba("#e0e1e2"), hunkHeader: rgba("#819293") },
    background: { added: rgba("#1d2b1f"), removed: rgba("#2b1d1d"), context: rgba("#101112") },
    highlight: { added: rgba("#2f4a33"), removed: rgba("#4a2f2f") },
    lineNumber: { text: rgba("#819293"), background: { added: rgba("#1d2b1f"), removed: rgba("#2b1d1d") } },
  }
  return theme as unknown as Context["theme"]
}

type Handler = (event: { type: string; data: Record<string, unknown> }) => void

/**
 * A terminal host in memory: synced storage as Solid stores, typed events you emit, a session inbox, prompts you can
 * hold or fail, and keymap layers that honor `enabled` and leave with their owner, as in the host.
 */
export function fakeHost(options: {
  diff?: () => FileDiffInfo[]; files?: Record<string, string>; lsp?: unknown
  /** The models OpenCode offers, which name the conversation's model on question cards. */
  models?: ModelInfo[]
  /** The project's worktrees as OpenCode lists them, and any it finds once it looks again. */
  worktrees?: { listed: string[]; found?: string[] }
} = {}) {
  const handlers = new Map<string, Set<Handler>>()
  const prompts: SessionPromptInput[] = []
  const toasts: { message: string; variant?: string }[] = []
  const pending = createStore<{ ids: string[] }>({ ids: [] })
  const panel = createStore<{ current?: { name: string; sessionID: string; presentation?: string } }>({})
  // Sessions the plugin makes, with the messages and status the host streams into its store for them.
  const created: (SessionCreateInput & { id: string; archived?: boolean })[] = []
  const interrupted: string[] = []
  const switched: { sessionID: string; model: { id: string; providerID: string } }[] = []
  // The conversation's model, which questions are answered with.
  const chat = createStore<{ model?: { id: string; providerID: string } }>({ model: { id: "claude-opus", providerID: "anthropic" } })
  // Where each diff was read, and the worktrees OpenCode knows.
  const diffs: { mode: string; directory?: string }[] = []
  let worktrees = options.worktrees?.listed ?? []
  const cancelled: string[] = []
  const sessions = createStore<{ messages: Record<string, SessionMessageInfo[]>; running: Record<string, boolean> }>({ messages: {}, running: {} })
  // What the server has stored for sessions the host's store doesn't hold, such as the archived ones questions run in.
  const served: Record<string, SessionMessageInfo[]> = {}
  const slots: { claim: Record<string, unknown>; render: (input: never) => unknown }[] = []
  let respond: (input: SessionPromptInput) => Promise<unknown> = async () => ({})
  let files = options.diff ?? (() => [])
  // Durable storage applies a change later, as a write the host acknowledges; memory storage applies it at once.
  const durable = <Value extends object>(_key: string, { initial }: { initial: Value }) => {
    const [value, set] = createStore<Value>(structuredClone(initial))
    return [value, (mutation: (draft: Value) => void) => Promise.resolve().then(() => set(produce(mutation)))] as const
  }
  const memory = <Value extends object>(_key: string, { initial }: { initial: Value }) => {
    const [value, set] = createStore<Value>(structuredClone(initial))
    return [value, (mutation: (draft: Value) => void) => { set(produce(mutation)) }] as const
  }
  const session = { open: true }
  const choices: unknown[] = []
  // The dialog shown, which a test renders beside what it's testing, as the host draws it over everything.
  const [dialog, setDialog] = createSignal<(() => JSX.Element) | undefined>()
  const layers = new Set<() => KeymapLayer>()
  const active = (layer: KeymapLayer) => typeof layer.enabled === "function" ? layer.enabled() : layer.enabled ?? true
  const dispatch = (id: string) => {
    const command = [...layers].map((layer) => layer()).filter(active).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .flatMap((layer) => (layer.commands ?? []) as KeymapCommand[])
      .find((candidate) => candidate.id === id && (typeof candidate.enabled === "function" ? candidate.enabled() : candidate.enabled ?? true))
    return command ? (command.run(), true) : false
  }
  const api = {
    theme: reviewTheme(),
    location: { directory: "/repo" },
    renderer: { widthMethod: "unicode", once() {}, off() {}, requestRender() {} },
    client: {
      session: {
        prompt: (input: SessionPromptInput) => { prompts.push(input); return respond(input) },
        diff: async () => files(),
        create: async (input: SessionCreateInput) => { const session = { ...input, id: `ses_side${created.length + 1}` }; created.push(session); return session },
        update: async (input: { sessionID: string; archived?: boolean }) => { const session = created.find((entry) => entry.id === input.sessionID)!; session.archived = input.archived },
        interrupt: async ({ sessionID }: { sessionID: string }) => { interrupted.push(sessionID) },
        switchModel: async (input: { sessionID: string; model: { id: string; providerID: string } }) => { switched.push(input) },
        inbox: { cancel: async ({ inboxID }: { inboxID: string }) => { cancelled.push(inboxID) } },
      },
      message: {
        list: async ({ sessionID, order }: { sessionID: string; order?: string }) => {
          const stored = served[sessionID]
          if (!stored) return { data: [{ id: "msg_first" }], cursor: {} }
          return { data: order === "desc" ? [...stored].reverse() : [...stored], cursor: {} }
        },
      },
      file: {
        read: async ({ path }: { path: string }) => {
          const content = options.files?.[path]
          if (content === undefined) throw new Error(`No such file: ${path}`)
          return new TextEncoder().encode(content)
        },
      },
      // Two config documents, as OpenCode layers them; the later one's servers win.
      config: { get: async () => [{ type: "document", info: {} }, { type: "document", info: options.lsp === undefined ? {} : { lsp: options.lsp } }] },
      rpc: () => ({ replies: async () => ({ replies: {} }) }),
      model: { list: async () => ({ data: options.models ?? [] }), default: async () => ({ data: options.models?.[0] ?? null }) },
      worktree: {
        list: async () => worktrees.map((directory) => ({ directory })),
        refresh: async () => { worktrees = [...new Set([...worktrees, ...options.worktrees?.found ?? []])] },
      },
      vcs: { diff: async (input: { mode: string; location?: { directory?: string } }) => { diffs.push({ mode: input.mode, directory: input.location?.directory }); return { data: files() } }, base: async () => ({ data: { name: "main" } }), branch: { list: async () => ({ data: ["main", "dev"] }) } },
    },
    data: {
      on: (type: string, handler: Handler) => {
        const set = handlers.get(type) ?? new Set()
        handlers.set(type, set.add(handler))
        return () => set.delete(handler)
      },
      session: {
        root: (id: string) => id,
        get: () => ({ location: { directory: "/repo" }, title: "Fix auth", projectID: "prj_repo", model: chat[0].model }),
        family: (id: string) => [id],
        status: (id: string) => id in sessions[0].running ? (sessions[0].running[id] ? "running" : "idle") : "running",
        message: { list: (id: string) => sessions[0].messages[id] ?? [], sync: async () => {} },
        pending: { list: () => pending[0].ids.map((id) => ({ id })), sync: async () => {} },
      },
    },
    storage: { store: durable, memory },
    ui: {
      toast: { show: (toast: { message: string; variant?: string }) => { toasts.push(toast) } },
      // Each select answers with the next queued choice, as if picked.
      dialog: {
        select: async () => choices.shift(),
        show: (render: () => JSX.Element) => setDialog(() => render),
        set: () => {},
        clear: () => setDialog(undefined),
      },
      slot: (claim: { render: (input: never) => unknown }) => { slots.push({ claim, render: claim.render }); return () => {} },
      panel: {
        current: () => panel[0].current,
        // Opening works only in a session, as in the host.
        open: (name: string, options?: { presentation?: string }) => {
          if (!session.open) return false
          panel[1]("current", { name, sessionID: SESSION, ...options?.presentation ? { presentation: options.presentation } : {} })
          return true
        },
        close: () => panel[1]("current", undefined),
      },
    },
    keymap: {
      dispatch,
      // The host's default bindings for moving between the conversation and a panel.
      shortcuts: (id: string) => ({ "pane.focus.left": ["ctrl+x left"], "pane.focus.right": ["ctrl+x right"] } as Record<string, string[]>)[id] ?? [],
      layer: (factory: () => KeymapLayer) => {
        let current: KeymapLayer = {}
        const layer = () => current
        createComputed(() => { current = factory() })
        layers.add(layer)
        onCleanup(() => layers.delete(layer))
      },
    },
  }
  return {
    api: api as unknown as Context,
    prompts,
    toasts,
    dispatch,
    emit: (type: string, data: Record<string, unknown>) => { for (const handler of handlers.get(type) ?? []) handler({ type, data }) },
    setPending: (ids: string[]) => pending[1]("ids", ids),
    respond: (next: typeof respond) => { respond = next },
    setDiff: (next: () => FileDiffInfo[]) => { files = next },
    slots,
    /** Queues what the next dialog.select picks. */
    choose: (...values: unknown[]) => { choices.push(...values) },
    panelOpen: () => panel[0].current,
    /** The dialog the host shows now, if any. */
    dialog,
    /** Sessions the plugin made, and what it interrupted or took back from their queue. */
    created, interrupted, cancelled, diffs, switched,
    /** Switches the conversation to another model, as the host's model picker does. */
    setChatModel: (model: { id: string; providerID: string }) => chat[1]("model", model),
    /** The server stores these messages for a session, and says so with an event, as a step ending does. */
    serve: async (sessionID: string, messages: SessionMessageInfo[]) => {
      served[sessionID] = messages
      for (const handler of handlers.get("session.step.ended") ?? []) handler({ type: "session.step.ended", data: { sessionID } })
      // The read it starts is debounced, then answered.
      await settle()
      await settle()
    },
    /** What the host's store holds for a session: its messages, as streamed in, and whether it's working. */
    stream: (sessionID: string, messages: SessionMessageInfo[], running: boolean) => {
      sessions[1]("messages", sessionID, messages)
      sessions[1]("running", sessionID, running)
    },
    /** Whether the route is a session, where panels can open. */
    session,
  }
}

/** A reactive session panel, as the host passes it: closing and focusing are recorded. */
export function fakePanel(width = 90) {
  const [panel, set] = createStore({ name: "opcode-review", sessionID: SESSION, width, presentation: "panel" as const, focused: true, closed: 0, focusCount: 0 })
  const input: PanelInput = {
    get name() { return panel.name },
    get sessionID() { return panel.sessionID },
    get width() { return panel.width },
    get presentation() { return panel.presentation },
    get focused() { return panel.focused },
    focus: () => set("focusCount", (count) => count + 1),
    close: () => set("closed", (count) => count + 1),
    toggleFullscreen: () => {},
  }
  return { input, state: panel, set }
}

/** Debounces run on the next tick, so tests wait for them with `settle`; timeouts never fire. */
export const fastTimer = (run: () => void, ms: number) => { const id = ms < 1000 ? setTimeout(run, 0) : undefined; return () => clearTimeout(id) }

/** Resolves once every pending microtask and timer queued so far has run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
