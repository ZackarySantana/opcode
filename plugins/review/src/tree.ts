/** Changed files as a folder tree, as editors show them. Knows nothing about the host. */

export type TreeRow =
  | { readonly kind: "folder"; readonly path: string; readonly name: string; readonly depth: number; readonly open: boolean }
  | { readonly kind: "file"; readonly path: string; readonly name: string; readonly depth: number }

interface Folder {
  readonly folders: Map<string, Folder>
  readonly files: string[]
}

function build(paths: readonly string[]): Folder {
  const root: Folder = { folders: new Map(), files: [] }
  for (const path of paths) {
    const parts = path.split("/")
    let folder = root
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part)
      if (!next) folder.folders.set(part, next = { folders: new Map(), files: [] })
      folder = next
    }
    folder.files.push(path)
  }
  return root
}

const byName = (a: string, b: string) => a.localeCompare(b)

/**
 * Rows for the tree: folders before files, each sorted by name, and a folder holding only one folder shown together
 * with it ("plugins/review/src"). Closed folders hide what's inside, except the folders holding `reveal`.
 */
export function fileTree(paths: readonly string[], closed: ReadonlySet<string> = new Set(), reveal?: string): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (folder: Folder, prefix: string, depth: number) => {
    for (const name of [...folder.folders.keys()].sort(byName)) {
      let child = folder.folders.get(name)!
      let label = name
      // Compact a chain of folders that each hold nothing but one folder.
      while (child.files.length === 0 && child.folders.size === 1) {
        const [next, inner] = [...child.folders][0]!
        label = `${label}/${next}`
        child = inner
      }
      const path = `${prefix}${label}`
      const open = !closed.has(path) || (reveal?.startsWith(`${path}/`) ?? false)
      rows.push({ kind: "folder", path, name: label, depth, open })
      if (open) walk(child, `${path}/`, depth + 1)
    }
    for (const path of [...folder.files].sort(byName)) rows.push({ kind: "file", path, name: path.slice(prefix.length), depth })
  }
  walk(build(paths), "", 0)
  return rows
}

/** Every file in the order the tree shows them, closed folders included, so next and previous follow the list. */
export const treeOrder = (paths: readonly string[]) => fileTree(paths).flatMap((row) => row.kind === "file" ? [row.path] : [])
