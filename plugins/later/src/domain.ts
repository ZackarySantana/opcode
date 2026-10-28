import type { Versioned } from "@opcode/core/follow"

export const PLUGIN_ID = "opcode-later"

export interface LaterItem {
  readonly id: string
  readonly message: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
}

export interface Settings {
  /** How many active items the sidebar lists before "+N more". */
  readonly sidebarItems: number
  /** Whether the agent's Later tools work. */
  readonly agentTools: boolean
}

export const defaultSettings: Settings = { sidebarItems: 5, agentTools: true }
export const sidebarItemChoices: readonly number[] = [3, 5, 10, 15, 20]

/**
 * The whole list as stored, one document, so each change is one atomic write. Every change raises `revision`, which
 * orders the states clients receive, whichever service wrote them.
 */
export interface LaterList {
  readonly revision: number
  /** In the user's order. */
  readonly active: readonly LaterItem[]
  /** Newest first. */
  readonly completed: readonly LaterItem[]
  readonly sidebarItems: number
  /** When the user turned the agent's tools off, or unset while they are on. */
  readonly toolsDisabledAt?: number
}

/** What clients receive: the list with its settings, without when the tools were turned off. */
export interface LaterState extends Versioned {
  readonly active: readonly LaterItem[]
  readonly completed: readonly LaterItem[]
  readonly settings: Settings
}

export const emptyList: LaterList = { revision: 0, active: [], completed: [], sidebarItems: defaultSettings.sidebarItems }

export function messageText(text: string): string {
  const message = text.trim()
  if (!message) throw new Error("Message cannot be empty")
  return message
}

/** Positions change when other items leave the list, so they never indicate a stale item. */
export function sameItem(left: LaterItem | undefined, right: LaterItem): boolean {
  return left !== undefined && left.id === right.id && left.message === right.message &&
    left.createdAt === right.createdAt && left.updatedAt === right.updatedAt && left.completedAt === right.completedAt
}

export function findItem(list: Pick<LaterList, "active" | "completed">, id: string): LaterItem | undefined {
  return list.active.find((item) => item.id === id) ?? list.completed.find((item) => item.id === id)
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

function isItem(value: unknown, completed: boolean): value is LaterItem {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return typeof item.id === "string" && typeof item.message === "string" && isTime(item.createdAt) && isTime(item.updatedAt) &&
    (completed ? isTime(item.completedAt) : item.completedAt === undefined)
}

/**
 * The stored list, or the empty one when nothing is stored yet. Anything else that isn't a list throws rather than
 * reading as empty, so it can't be overwritten. Stored objects are kept as they are, fields this version doesn't know
 * included, so a write by this version keeps what a newer one stored beside them.
 */
export function readList(stored: unknown): LaterList {
  if (stored === undefined) return emptyList
  const list = stored as Record<string, unknown> | null
  if (!list || typeof list !== "object" || !Number.isSafeInteger(list.revision) || (list.revision as number) < 0 ||
    !Array.isArray(list.active) || !list.active.every((item) => isItem(item, false)) ||
    !Array.isArray(list.completed) || !list.completed.every((item) => isItem(item, true)) ||
    (list.toolsDisabledAt !== undefined && !isTime(list.toolsDisabledAt))) {
    throw new Error("The stored Later list is not in a form this version reads")
  }
  return { ...list as unknown as LaterList, sidebarItems: sidebarItemChoices.includes(list.sidebarItems as number) ? list.sidebarItems as number : defaultSettings.sidebarItems }
}

const project = ({ id, message, createdAt, updatedAt, completedAt }: LaterItem): LaterItem =>
  ({ id, message, createdAt, updatedAt, ...completedAt === undefined ? {} : { completedAt } })

/**
 * The list as clients see it. Its revision orders states from every service, which all change one stored list, so they
 * share one constant service identity.
 */
export function view(list: LaterList): LaterState {
  return {
    server: PLUGIN_ID, started: 0, revision: list.revision,
    active: list.active.map(project), completed: list.completed.map(project),
    settings: { sidebarItems: list.sidebarItems, agentTools: list.toolsDisabledAt === undefined },
  }
}

/** Each change returns the next list, without its new revision, or undefined when it doesn't apply. */
export function addItem(list: LaterList, id: string, text: string, now: number): LaterList {
  return { ...list, active: [...list.active, { id, message: messageText(text), createdAt: now, updatedAt: now }] }
}

/** Changes apply only to the item as the caller saw it: one changed elsewhere meanwhile is left alone. */
export function editItem(list: LaterList, item: LaterItem, text: string, now: number): LaterList | undefined {
  const message = messageText(text)
  if (!sameItem(findItem(list, item.id), item)) return undefined
  const edit = (entry: LaterItem) => entry.id === item.id ? { ...entry, message, updatedAt: now } : entry
  return { ...list, active: list.active.map(edit), completed: list.completed.map(edit) }
}

export function completeItem(list: LaterList, item: LaterItem, now: number): LaterList | undefined {
  const found = list.active.find((entry) => entry.id === item.id)
  if (!found || !sameItem(found, item)) return undefined
  return { ...list, active: list.active.filter((entry) => entry !== found), completed: [{ ...found, completedAt: now, updatedAt: now }, ...list.completed] }
}

/** Restored items go to the end of the active list. */
export function restoreItem(list: LaterList, item: LaterItem, now: number): LaterList | undefined {
  const found = list.completed.find((entry) => entry.id === item.id)
  if (!found || !sameItem(found, item)) return undefined
  const { completedAt: _, ...restored } = found
  return { ...list, active: [...list.active, { ...restored, updatedAt: now }], completed: list.completed.filter((entry) => entry !== found) }
}

export function deleteItem(list: LaterList, item: LaterItem): LaterList | undefined {
  if (!sameItem(findItem(list, item.id), item)) return undefined
  return { ...list, active: list.active.filter((entry) => entry.id !== item.id), completed: list.completed.filter((entry) => entry.id !== item.id) }
}

/**
 * Swaps an active item with its neighbor. Order isn't part of an item, so moving one doesn't make pending edits of it
 * stale, and quick moves of the same item each apply. Undefined past either end or once the item isn't active.
 */
export function moveItem(list: LaterList, id: string, offset: -1 | 1): LaterList | undefined {
  const index = list.active.findIndex((entry) => entry.id === id)
  const neighbor = index < 0 ? undefined : list.active[index + offset]
  if (!neighbor) return undefined
  const active = [...list.active]
  active[index + offset] = active[index]!
  active[index] = neighbor
  return { ...list, active }
}

/** Turning the tools off again keeps the first time: moving it later would add them to sessions created since. */
export function changeSettings(list: LaterList, change: Partial<Settings>, now: number): LaterList {
  const { toolsDisabledAt, ...rest } = list
  const sidebarItems = change.sidebarItems !== undefined && sidebarItemChoices.includes(change.sidebarItems) ? change.sidebarItems : list.sidebarItems
  const disabledAt = change.agentTools === undefined ? toolsDisabledAt : change.agentTools ? undefined : toolsDisabledAt ?? now
  return { ...rest, sidebarItems, ...disabledAt === undefined ? {} : { toolsDisabledAt: disabledAt } }
}
