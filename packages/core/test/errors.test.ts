import { expect, test } from "bun:test"
import { errorMessage } from "../src/index"

test.each([
  [new Error("database unavailable"), "database unavailable"],
  ["connection lost", "connection lost"],
  [{ message: "request rejected", code: 403 }, "request rejected"],
  [{ message: 42 }, "An unexpected error occurred"],
  [null, "An unexpected error occurred"],
  [new Error(""), "An unexpected error occurred"],
  ["", "An unexpected error occurred"],
])("errors from different adapters become useful toast messages (%j)", (error, message) => {
  expect(errorMessage(error)).toBe(message)
})
