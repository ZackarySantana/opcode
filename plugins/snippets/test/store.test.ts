import { expect, spyOn, test } from "bun:test"
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tempDir } from "@opcode/ui/test-support/host"
import { snippetDirectories, SnippetStore } from "../src/store"

function fixture() {
  const root = tempDir("opcode-snippets-store-")
  const store = new SnippetStore({ global: join(root.path, "global"), project: join(root.path, "project") })
  return { root, store }
}

test("writes, lists, and removes snippet files, with no temporary files left behind", async () => {
  const { root, store } = fixture()
  try {
    await store.write("global", "review", { description: "Review", aliases: ["rv"], body: "Check the diff.\n" })
    await store.write("global", "review", { aliases: [], body: "Check it again." })
    expect(await store.list()).toEqual([{ name: "review", scope: "global", path: join(root.path, "global/review.md"), aliases: [], body: "Check it again." }])
    expect(await readdir(join(root.path, "global"))).toEqual(["review.md"])
    expect(await store.remove("global", "review")).toBe(true)
    expect(await store.remove("global", "review")).toBe(false)
  } finally { root.remove() }
})

test("names cannot leave the snippet directory, and project snippets cannot be symlinks", async () => {
  const { root, store } = fixture()
  try {
    for (const name of ["../escape", "a/b", "123"]) {
      await expect(store.write("global", name, { aliases: [], body: "x" })).rejects.toThrow("Invalid snippet name")
      await expect(store.remove("project", name)).rejects.toThrow("Invalid snippet name")
    }
    await store.write("project", "real", { aliases: [], body: "real" })
    const secret = join(root.path, "secret.txt")
    await writeFile(secret, "secret")
    await symlink(secret, join(root.path, "project/linked.md"))
    expect((await store.list()).map((snippet) => snippet.name)).toEqual(["real"])
    await expect(store.write("project", "linked", { aliases: [], body: "x" })).rejects.toThrow("not a regular file")
    expect(await store.remove("project", "linked")).toBe(false)
    expect(await readFile(secret, "utf8")).toBe("secret")
    // A linked project directory is ignored as a whole.
    const elsewhere = new SnippetStore({ global: join(root.path, "none"), project: join(root.path, "repo/.opencode/snippets") })
    await mkdir(join(root.path, "repo"))
    await symlink(join(root.path, "project"), join(root.path, "repo/.opencode"))
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try { expect(await elsewhere.list()).toEqual([]) } finally { warn.mockRestore() }
    await expect(elsewhere.write("project", "x", { aliases: [], body: "x" })).rejects.toThrow("cannot be symlinks")
  } finally { root.remove() }
})

test("a symlinked global snippet, as in a dotfiles checkout, is read and updated where it points", async () => {
  const { root, store } = fixture()
  try {
    const dotfile = join(root.path, "dotfiles/review.md")
    await mkdir(join(root.path, "dotfiles"))
    await mkdir(join(root.path, "global"))
    await writeFile(dotfile, "old")
    await symlink(dotfile, join(root.path, "global/review.md"))
    expect((await store.list()).map((snippet) => snippet.body)).toEqual(["old"])
    await store.write("global", "review", { aliases: [], body: "new" })
    expect(await readFile(dotfile, "utf8")).toBe("new\n")
    expect((await store.list()).map((snippet) => snippet.body)).toEqual(["new"])
  } finally { root.remove() }
})

test("global snippets follow XDG_CONFIG_HOME; project snippets live at the repository root", () => {
  const project = { id: "abc", directory: "/repo" }
  expect(snippetDirectories({ directory: "/repo/sub", project }, { XDG_CONFIG_HOME: "/xdg" }, "/home")).toEqual({ global: "/xdg/opencode/snippets", project: "/repo/.opencode/snippets" })
  expect(snippetDirectories({ directory: "/tmp/notes", project: { id: "global", directory: "/" } }, {}, "/home")).toEqual({ global: "/home/.config/opencode/snippets", project: "/tmp/notes/.opencode/snippets" })
})
