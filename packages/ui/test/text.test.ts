import { expect, test } from "bun:test"
import { cellWidth, shorten } from "@opcode/ui"

test("truncation budgets terminal cells without splitting combining or joined graphemes", () => {
  expect(shorten("😀😀😀", 3)).toBe("😀…")
  expect(shorten("東京案内", 5)).toBe("東京…")
  expect(shorten("e\u0301e\u0301e\u0301", 2)).toBe("e\u0301…")
  expect(shorten("👩‍💻👩‍💻", 3)).toBe("👩‍💻…")
  expect(shorten("text", 0)).toBe("")
  expect(shorten("text", -1)).toBe("")
  expect(shorten("東京", 4)).toBe("東京")
  for (const method of ["unicode", "unicode-wide", "wcwidth"] as const) {
    for (const text of ["normal text", "東京案内", "e\u0301e\u0301e\u0301", "👩‍💻👩‍💻"]) {
      for (let budget = 0; budget < 10; budget++) expect(cellWidth(shorten(text, budget, method), method)).toBeLessThanOrEqual(budget)
    }
  }
})

test("single-line truncation normalizes whitespace and floors fractional budgets", () => {
  expect(shorten("a\nb\rc\td", 7)).toBe("a b c d")
  expect(shorten("abcd", 2.9)).toBe("a…")
  expect(shorten("", 0)).toBe("")
})

test("cell widths account for wide and combining characters", () => {
  expect(cellWidth("東京")).toBe(4)
  expect(cellWidth("e\u0301")).toBe(1)
  expect(cellWidth("👩‍💻")).toBe(2)
})
