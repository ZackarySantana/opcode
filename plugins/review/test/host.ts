import { mockTheme } from "@opcode/ui/test-support/host"
import type { FileDiffInfo, SessionPromptInput } from "@opencode/client"
import type { Context, KeymapCommand, KeymapLayer, PanelInput } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { createComputed, onCleanup } from "solid-js"
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
export function fakeHost(options: { diff?: () => FileDiffInfo[] } = {}) {
  const handlers = new Map<string, Set<Handler>>()
  const prompts: SessionPromptInput[] = []
  const toasts: { message: string; variant?: string }[] = []
  const pending = createStore<{ ids: string[] }>({ ids: [] })
  const panel = createStore<{ current?: { name: string; sessionID: string } }>({})
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
      },
      message: { list: async () => ({ data: [{ id: "msg_first" }], cursor: {} }) },
      rpc: () => ({ replies: async () => ({ replies: {} }) }),
      vcs: { diff: async () => ({ data: files() }), base: async () => ({ data: { name: "main" } }), branch: { list: async () => ({ data: ["main", "dev"] }) } },
    },
    data: {
      on: (type: string, handler: Handler) => {
        const set = handlers.get(type) ?? new Set()
        handlers.set(type, set.add(handler))
        return () => set.delete(handler)
      },
      session: {
        root: (id: string) => id,
        get: () => ({ location: { directory: "/repo" } }),
        status: () => "running",
        pending: { list: () => pending[0].ids.map((id) => ({ id })), sync: async () => {} },
      },
    },
    storage: { store: durable, memory },
    ui: {
      toast: { show: (toast: { message: string; variant?: string }) => { toasts.push(toast) } },
      // Each select answers with the next queued choice, as if picked.
      dialog: { select: async () => choices.shift() },
      slot: (claim: { render: (input: never) => unknown }) => { slots.push({ claim, render: claim.render }); return () => {} },
      panel: {
        current: () => panel[0].current,
        // Opening works only in a session, as in the host.
        open: (name: string) => { if (!session.open) return false; panel[1]("current", { name, sessionID: SESSION }); return true },
        close: () => panel[1]("current", undefined),
      },
    },
    keymap: {
      dispatch,
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
