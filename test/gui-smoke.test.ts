import { afterAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { buildGui } from "../scripts/build"
import { hasGui, pluginIDs, privateWorkspaces, repositoryRoot } from "../scripts/packaging"

// Loads each plugin's built desktop bundle the way the app does, against a recording host that is on Home (no routed
// session): setup must not throw, every contribution must evaluate, and every message it reads must exist.

const temporary: string[] = []
afterAll(() => Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))))

const provided: Record<string, () => Promise<unknown>> = {
  "@opencode/plugin/gui": () => import("@opencode/plugin/gui"),
  "@opencode/plugin/rpc": () => import("@opencode/plugin/rpc"),
  "@opencode/client": () => import("@opencode/client"),
  "solid-js": () => import("solid-js"),
  // Bun resolves Solid's server renderer, which refuses the DOM setup a bundle runs at module scope; nothing renders here.
  "solid-js/web": async () => new Proxy({}, { get: (_, key) => key === "then" ? undefined : inert() }),
  "solid-js/store": () => import("solid-js/store"),
  // The app's Effect is the one the SDK depends on.
  effect: () => import(Bun.resolveSync("effect", Bun.resolveSync("@opencode/plugin/gui", import.meta.dir))),
}

async function load(bundle: string) {
  const modules = new Map<string, unknown>()
  const code = await readFile(bundle, "utf8")
  for (const [, name] of code.matchAll(/require\("([^"]+)"\)/g)) {
    const module = provided[name!]
    if (!module) throw new Error(`The bundle requires ${name}, which the app does not provide`)
    modules.set(name!, await module())
  }
  const module = { exports: {} as { default?: unknown } }
  new Function("require", "module", "exports", code)((name: string) => modules.get(name), module, module.exports)
  return module.exports.default as {
    i18n?: { en: Record<string, string> }
    stores?: Record<string, { scope?: string; initial?: unknown }>
    setup?: (ctx: unknown) => unknown
  }
}

/** Absorbs any read or call; calls answer with a promise that never settles, like a server that has not replied. */
function inert(): any {
  const target = () => {}
  return new Proxy(target, {
    get: (_, key) => key === "then" ? (() => new Promise(() => {})) : key === Symbol.toPrimitive ? () => "" : inert(),
    apply: () => inert(),
  })
}

function host(id: string, definition: NonNullable<Awaited<ReturnType<typeof load>>>) {
  const en = definition.i18n?.en ?? {}
  const missing = new Set<string>()
  const contributions: { registry: string; item: unknown }[] = []
  const format = (text: string, params: Record<string, unknown> = {}) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? ""))
  const t = (key: string, params?: Record<string, unknown>) => {
    if (en[key] === undefined && !key.startsWith("common.")) missing.add(key)
    return format(en[key] ?? key, params)
  }
  const persisted = (initial: unknown) => ({ value: initial, ready: () => true, update() {}, set() {} })
  const stores = Object.fromEntries(Object.entries(definition.stores ?? {}).map(([key, store]) => {
    return [key, store.scope === "session" ? () => persisted(undefined) : persisted(store.initial)]
  }))
  const known: Record<string, unknown> = {
    id,
    options: {},
    app: { name: "opencode", version: "2.2.0", channel: "prod", platform: "desktop", packaged: true },
    signal: new AbortController().signal,
    stores,
    t,
    plural: (key: string, count: number, params?: Record<string, unknown>) => t(`${key}.${count === 1 ? "one" : "other"}`, { count, ...params }),
    add: (registry: { id: string }, item: unknown) => {
      contributions.push({ registry: registry.id, item })
      return () => {}
    },
    list: () => [],
    provide: () => () => {},
    use: () => () => ({ status: "pending" }),
    sessions: { list: () => [], current: () => undefined },
    screen: { current: () => undefined },
    servers: { list: () => [], get: () => undefined },
    storage: { store: (_: string, options: { initial: unknown }) => persisted(options.initial), memory: (_: string, options: { initial: object }) => createStore(options.initial), remove() {} },
    layout: new Proxy({ state: () => "closed", stored: () => [], ready: () => true, narrow: () => false }, { get: (target, key) => (target as Record<PropertyKey, unknown>)[key] ?? inert() }),
    dialogs: new Proxy({ active: () => false }, { get: (target, key) => (target as Record<PropertyKey, unknown>)[key] ?? inert() }),
  }
  const ctx = new Proxy(known, { get: (target, key) => key in target ? target[key as string] : inert() })
  return { ctx, contributions, missing }
}

const session = { key: "sidecar\nses_smoke", id: "ses_smoke", tab: "tab", pending: false, server: { id: "sidecar" }, location: undefined, visit: {}, directory: "/tmp/smoke", local: true, background: [], project: undefined, listedProject: undefined }
const screen = { file: inert(), comment: inert(), composer: inert() }

/** What the host does with a contribution before it draws anything. */
function evaluate(registry: string, contribution: unknown): Record<string, any> | undefined {
  const item = (typeof contribution === "function" && registry !== "style" ? (contribution as () => unknown)() : contribution) as Record<string, any> | undefined
  if (!item || typeof item !== "object") return item
  for (const key of ["title", "label", "description"]) void item[key]
  if (registry === "composer-pill") void item.show({ session, screen })
  if (registry === "panel") for (const tab of item.list({ session, screen, open: [item.id] })) void tab.title
  if (registry === "settings-page") void item.entries
  return item
}

const plugins = pluginIDs.filter((id) => hasGui(join(repositoryRoot, "plugins", id)))

test.each(plugins)("%s's desktop part sets up and contributes on Home", async (id) => {
  const directory = await mkdtemp(join(tmpdir(), "gui-smoke-"))
  temporary.push(directory)
  const bundle = join(directory, "gui-experimental.cjs")
  await buildGui(join(repositoryRoot, "plugins", id), bundle, await privateWorkspaces(repositoryRoot))
  const definition = await load(bundle)
  expect(typeof definition.setup).toBe("function")
  const { ctx, contributions, missing } = host(`opcode-${id}`, definition)
  createRoot((dispose) => {
    try {
      const cleanup = definition.setup!(ctx)
      expect(cleanup instanceof Promise).toBe(false)
      const ids = new Map<string, Set<string>>()
      for (const { registry, item } of contributions) {
        const evaluated = evaluate(registry, item)
        if (!evaluated?.id) continue
        const seen = ids.get(registry) ?? new Set()
        expect(seen.has(evaluated.id)).toBe(false)
        ids.set(registry, seen.add(evaluated.id))
        if (registry === "command") {
          expect(evaluated.title).toBeTruthy()
          expect(typeof evaluated.run).toBe("function")
        }
      }
      expect(ids.get("command")?.size).toBeGreaterThan(0)
    } finally { dispose() }
  })
  expect([...missing]).toEqual([])
}, 60_000)
