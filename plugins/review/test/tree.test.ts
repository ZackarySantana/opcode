import { expect, test } from "bun:test"
import { fileTree, treeOrder } from "../src/tree"

const paths = ["plugins/review/src/panel.tsx", "README.md", "plugins/review/src/host.ts", "plugins/review/test/panel.test.tsx", "docs/a.md", "package.json"]
const show = (rows: ReturnType<typeof fileTree>) => rows.map((row) => `${"  ".repeat(row.depth)}${row.kind === "folder" ? (row.open ? "▾ " : "▸ ") : ""}${row.name}`)

test("folders come before files, and a folder holding only a folder shares its row", () => {
  expect(show(fileTree(paths))).toEqual([
    "▾ docs",
    "  a.md",
    "▾ plugins/review",
    "  ▾ src",
    "    host.ts",
    "    panel.tsx",
    "  ▾ test",
    "    panel.test.tsx",
    "package.json",
    "README.md",
  ])
  expect(treeOrder(paths)).toEqual(["docs/a.md", "plugins/review/src/host.ts", "plugins/review/src/panel.tsx", "plugins/review/test/panel.test.tsx", "package.json", "README.md"])
})

test("a closed folder hides its files, unless it holds the open file", () => {
  const closed = new Set(["plugins/review", "docs"])
  expect(show(fileTree(paths, closed))).toEqual(["▸ docs", "▸ plugins/review", "package.json", "README.md"])
  expect(show(fileTree(paths, closed, "plugins/review/test/panel.test.tsx"))).toEqual([
    "▸ docs", "▾ plugins/review", "  ▾ src", "    host.ts", "    panel.tsx", "  ▾ test", "    panel.test.tsx", "package.json", "README.md",
  ])
})
