import { expect, test } from "bun:test"
import type { LaterItem } from "../src/domain"
import { en } from "../src/gui/i18n"
import { launcherDescription, pillView, rowLabel, useItem, useToast, type UseOutcome } from "../src/gui/view"

const item = (id: string, message: string, extra: Partial<LaterItem> = {}): LaterItem =>
  ({ id, message, createdAt: 1, updatedAt: 1, ...extra })

test("menu rows show the first line, mark more lines, and shorten long text at a word", () => {
  expect(rowLabel("bump the SDK")).toBe("bump the SDK")
  expect(rowLabel("\n  fix the docs \nand the tests")).toBe("fix the docs …")
  const long = rowLabel("the cost column should show tokens too, alongside dollars, for every model in the list", 40)
  expect(long.length).toBeLessThanOrEqual(40)
  expect(long).toBe("the cost column should show tokens…")
  expect(rowLabel("x".repeat(50), 20)).toBe(`${"x".repeat(19)}…`)
})

test("the launcher shows the active count, and nothing while empty", () => {
  expect(launcherDescription([])).toBeUndefined()
  expect(launcherDescription([item("a", "one"), item("b", "two")])).toBe("2")
})

test("the composer pill lists active items in order and inserts the picked one, and is absent while empty", () => {
  const used: string[] = []
  const text = { label: "2 for later", title: "Insert into the prompt" }
  expect(pillView([], text, () => {})).toBeUndefined()
  const view = pillView([item("a", "first"), item("b", "second\nmore")], text, (picked) => used.push(picked.id))!
  expect(view).toMatchObject({ label: "2 for later", title: "Insert into the prompt" })
  expect(view.rows?.map((row) => [row.id, row.label, row.detail])).toEqual([["a", "first", "1"], ["b", "second …", "2"]])
  view.rows![1]!.run!()
  expect(used).toEqual(["b"])
})

/** A composer that records what it was given. */
function composer() {
  const calls: string[] = []
  return { calls, insert: (text: string) => calls.push(`insert:${text}`), focus: () => calls.push("focus") }
}

test("using an item types it into the prompt, focuses it, and completes the item", async () => {
  const prompt = composer()
  const target = item("a", "café ☕\nadd tests")
  const completed: LaterItem[] = []
  expect(await useItem(target, target, prompt, async (done) => { completed.push(done); return true })).toEqual({ type: "used" })
  expect(prompt.calls).toEqual(["insert:café ☕\nadd tests", "focus"])
  expect(completed).toEqual([target])
})

test("an item that changed or left the list, or no prompt, inserts nothing and completes nothing", async () => {
  const target = item("a", "original")
  const never = async () => { throw new Error("must not complete") }
  for (const [latest, prompt] of [
    [item("a", "edited", { updatedAt: 2 }), composer()],
    [undefined, composer()],
    [target, undefined],
  ] as const) {
    const outcome = await useItem(target, latest, prompt, never)
    expect(outcome.type).toBe(prompt ? "changed" : "unavailable")
    expect(prompt?.calls ?? []).toEqual([])
  }
  const done = item("b", "done", { completedAt: 3 })
  expect(await useItem(done, done, composer(), never)).toEqual({ type: "changed" })
})

test("after inserting, a refused or failed completion is reported, since the text is already in the prompt", async () => {
  const target = item("a", "original")
  const prompt = composer()
  expect(await useItem(target, target, prompt, async () => false)).toEqual({ type: "kept" })
  expect(await useItem(target, target, prompt, async () => { throw new Error("server down") })).toEqual({ type: "failed", message: "server down" })
  expect(prompt.calls.filter((call) => call.startsWith("insert"))).toHaveLength(2)
})

test("every outcome has copy, and only a failure is an error", () => {
  const outcomes: UseOutcome[] = [{ type: "used" }, { type: "kept" }, { type: "changed" }, { type: "unavailable" }, { type: "failed", message: "server down" }]
  for (const outcome of outcomes) {
    const toast = useToast(outcome)
    expect(Object.keys(en)).toContain(toast.title)
    expect(toast.variant === "error").toBe(outcome.type === "failed")
  }
  expect(useToast({ type: "failed", message: "server down" }).description).toBe("server down")
})
