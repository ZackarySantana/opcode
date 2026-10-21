import { expect, test } from "bun:test"
import { listWindow } from "../src/view"

test("list windows follow selection and remain valid after resizing or losing rows", () => {
  for (const height of [10, 4]) {
    const window = listWindow(60, 45, height)
    expect(window.selected).toBe(45)
    expect(window.start).toBeLessThanOrEqual(window.selected)
    expect(window.end).toBeGreaterThan(window.selected)
    expect(window.end - window.start).toBeLessThanOrEqual(height)
  }
  expect(listWindow(3, 45, 10)).toEqual({ selected: 2, start: 0, end: 3 })
  expect(listWindow(0, 45, 10)).toEqual({ selected: 0, start: 0, end: 0 })
})
