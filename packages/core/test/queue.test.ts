import { expect, test } from "bun:test"
import { createSerialQueue } from "../src/index"

test("queued operations wait and run in submission order, returning their own results", async () => {
  const serial = createSerialQueue()
  const started: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const first = serial(async () => {
    started.push("first")
    await gate
    return "first result"
  })
  const second = serial(async () => {
    started.push("second")
    return "second result"
  })
  const third = serial(async () => {
    started.push("third")
    return "third result"
  })
  await Promise.resolve()
  expect(started).toEqual(["first"])
  release()
  expect(await Promise.all([first, second, third])).toEqual(["first result", "second result", "third result"])
  expect(started).toEqual(["first", "second", "third"])
})

test("a failed write reaches its caller without blocking subsequent operations", async () => {
  const serial = createSerialQueue()
  const failed = serial(async () => { throw new Error("write failed") })
  const next = serial(async () => "saved")
  await expect(failed).rejects.toThrow("write failed")
  expect(await next).toBe("saved")
})
