import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
const manifests: { path: string; value: typeof manifest }[] = [{ path: "package.json", value: manifest }]
for (const directory of ["plugins", "packages"]) {
  for await (const path of new Bun.Glob(`${directory}/*/package.json`).scan(root)) {
    manifests.push({ path, value: await Bun.file(`${root}/${path}`).json() })
  }
}

function resolveCatalog(name: string, reference: string): string | undefined {
  const catalogName = reference.slice("catalog:".length)
  const catalog = catalogName ? manifest.workspaces.catalogs[catalogName] : manifest.workspaces.catalog
  return catalog?.[name]
}

test("OpenCode SDK packages move as one catalog version", () => {
  const versions = new Set<string | undefined>()
  const names = new Set<string>()
  for (const { value } of manifests) {
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, reference] of Object.entries(value[field] ?? {}) as [string, string][]) {
        if (!name.startsWith("@opencode/")) continue
        names.add(name)
        versions.add(resolveCatalog(name, reference))
      }
    }
  }
  for (const name of ["@opencode/client", "@opencode/plugin", "@opencode/theme"]) expect(names.has(name)).toBe(true)
  expect(versions.has(undefined)).toBe(false)
  expect(versions.size).toBe(1)
})

test("workspace dependencies use the shared catalog rather than drifting per plugin", async () => {
  for (const { path, value: workspace } of manifests) {
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const [name, version] of Object.entries(workspace[field] ?? {}) as [string, string][]) {
          if (name.startsWith("@opcode/")) {
            expect(version, `${path}: ${name}`).toStartWith("workspace:")
            continue
          }
          expect(version, `${path}: ${name}`).toStartWith("catalog:")
          expect(resolveCatalog(name, version), `${path}: missing catalog entry ${name}`).toBeDefined()
        }
      }
  }
})
