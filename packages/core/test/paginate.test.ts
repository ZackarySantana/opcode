import { expect, test } from "bun:test"
import { paginate, type Page } from "../src/paginate"

const collect = async <T>(pages: AsyncIterable<readonly T[]>) => {
  const all: T[] = []
  for await (const page of pages) all.push(...page)
  return all
}

test("follows cursors across pages until the server stops returning one", async () => {
  const requests: (string | undefined)[] = []
  const pages: Record<string, Page<number>> = {
    first: { data: [1, 2], cursor: { next: "b" } },
    b: { data: [3], cursor: { next: "c" } },
    c: { data: [4], cursor: { next: null } },
  }
  const items = await collect(paginate(async (cursor) => { requests.push(cursor); return pages[cursor ?? "first"]! }))
  expect(items).toEqual([1, 2, 3, 4])
  expect(requests).toEqual([undefined, "b", "c"])
})

test("a repeated cursor fails instead of looping forever", async () => {
  let requests = 0
  const pages = paginate(async (cursor) => { requests++; return { data: [requests], cursor: { next: cursor === "a" ? "b" : "a" } } })
  await expect(collect(pages)).rejects.toThrow("repeated a cursor")
  expect(requests).toBe(3)
})

test("abort stops before the next request and discards an in-flight page", async () => {
  const controller = new AbortController()
  let requests = 0
  const pages = paginate(async () => {
    requests++
    if (requests === 2) controller.abort()
    return { data: [requests], cursor: { next: `page-${requests}` } }
  }, controller.signal)
  const seen: number[] = []
  await expect((async () => { for await (const page of pages) seen.push(...page) })()).rejects.toThrow()
  expect(seen).toEqual([1])
  expect(requests).toBe(2)

  let started = false
  await expect(collect(paginate(async () => { started = true; return { data: [], cursor: {} } }, AbortSignal.abort()))).rejects.toThrow()
  expect(started).toBe(false)
})
