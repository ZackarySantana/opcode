import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { dependencyFields, hostSingletons, manifestAt, pluginIDs, privateWorkspaces, publicManifest, publicPackageName, repositoryRoot, resolveCatalog, run, runtimeDependencies, type Manifest } from "./packaging"

export type ReleaseChange = { name: string; type: "patch" | "minor" | "major" }

export function parseChangeset(text: string): ReleaseChange[] {
  const match = /^---[\t ]*\r?\n([\s\S]*?)^---[\t ]*(?:\r?\n|$)/m.exec(text)
  if (!match) throw new Error("Changesets must have YAML frontmatter")
  const value = Bun.YAML.parse(match[1]!) as Record<string, unknown> | null
  return Object.entries(value ?? {}).map(([name, type]) => {
    if (type !== "patch" && type !== "minor" && type !== "major") throw new Error(`Invalid release type for ${name}: ${type}`)
    return { name, type }
  })
}

export function requiredConsumers(changedWorkspaces: Set<string>, manifests: Map<string, Manifest>): Set<string> {
  function uses(name: string, seen = new Set<string>()): boolean {
    if (changedWorkspaces.has(name)) return true
    if (seen.has(name)) return false
    seen.add(name)
    const manifest = manifests.get(name)
    return dependencyFields.some((field) => Object.keys(manifest?.[field] ?? {}).some((dependency) => manifests.has(dependency) && uses(dependency, seen)))
  }
  return new Set([...manifests].filter(([name, manifest]) => !manifest.private && uses(name)).map(([name]) => name))
}

export function assertReleaseCoverage(required: Set<string>, changes: ReleaseChange[]) {
  const released = new Set(changes.map((change) => change.name))
  const missing = [...required].filter((name) => !released.has(name))
  if (missing.length) throw new Error(`Add explicit consumer changesets for: ${missing.sort().join(", ")}`)
}

const git = async (root: string, args: string[]) => (await run(["git", ...args], root)).trimEnd()
const lines = (text: string) => text.split("\n").filter(Boolean)

/** Repository-wide catalog invariants: OpenCode lockstep and host peer floors matching the development pins. */
export function assertCatalogInvariants(root: Manifest, workspaces: Iterable<Manifest> = []) {
  const catalog = root.workspaces?.catalog ?? {}
  const openCodeVersions = new Set(Object.entries(catalog).filter(([name]) => name.startsWith("@opencode/")).map(([, version]) => version))
  for (const manifest of [root, ...workspaces]) {
    for (const field of [...dependencyFields, "devDependencies"] as const) {
      for (const [name, specifier] of Object.entries((manifest[field] ?? {}) as Record<string, string>)) {
        if (name.startsWith("@opencode/")) openCodeVersions.add(resolveCatalog(specifier, name, root))
      }
    }
  }
  if (openCodeVersions.size > 1) throw new Error("All @opencode/* catalog versions must move together")
  for (const name of hostSingletons(root)) {
    const range = root.workspaces!.catalogs!.host![name]!
    const pin = catalog[name]
    const floor = /^>=\s*v?(\S+)\s+<\S+$/.exec(range.trim())?.[1]
    if (!pin || !floor || !Bun.semver.satisfies(pin, range) || Bun.semver.order(pin, floor) !== 0) {
      throw new Error(`Host catalog range ${name}@"${range}" must be ">=<pin> <limit>" with its lower bound equal to the default catalog pin (${pin ?? "missing"})`)
    }
  }
}

async function publicManifests(root: string) {
  const privateMap = await privateWorkspaces(root)
  const manifests = new Map([...privateMap].map(([name, workspace]) => [name, workspace.manifest]))
  const manifestPaths = new Map([...privateMap].map(([name, workspace]) => [name, `${relative(root, workspace.directory)}/package.json`]))
  for (const id of pluginIDs) {
    const manifest = await publicManifest(root, id)
    manifests.set(manifest.name, manifest)
    manifestPaths.set(manifest.name, `plugins/${id}/package.json`)
  }
  return { privateMap, manifests, manifestPaths }
}

/** Parse every pending changeset and reject any that names something other than a public plugin. */
export async function validatePendingChangesets(root = repositoryRoot) {
  const { manifests } = await publicManifests(root)
  const pending = (await readdir(join(root, ".changeset"))).filter((file) => file.endsWith(".md") && file !== "README.md")
  const changes = new Map<string, ReleaseChange[]>()
  for (const file of pending) {
    const fileChanges = parseChangeset(await readFile(join(root, ".changeset", file), "utf8"))
    for (const change of fileChanges) {
      const manifest = manifests.get(change.name)
      if (!manifest || manifest.private) throw new Error(`Changesets must name public plugins, not ${change.name} (${file})`)
    }
    changes.set(file, fileChanges)
  }
  return changes
}

/** Compares `base`'s merge-base with the working tree, so local uncommitted work counts too. */
export async function checkReleasePolicy(root = repositoryRoot, base = "origin/main") {
  const rootManifest = await manifestAt(root)
  const { privateMap, manifests, manifestPaths } = await publicManifests(root)
  assertCatalogInvariants(rootManifest, manifests.values())
  const ancestor = await git(root, ["merge-base", base, "HEAD"])
  const untracked = lines(await git(root, ["ls-files", "--others", "--exclude-standard"]))
  const changed = [...lines(await git(root, ["diff", "--name-only", "--no-renames", ancestor])), ...untracked]
  const privateChanges = new Set([...privateMap].filter(([, workspace]) => changed.some((file) => file.startsWith(`packages/${workspace.manifest.name.split("/")[1]}/src/`) || file === `packages/${workspace.manifest.name.split("/")[1]}/package.json`)).map(([name]) => name))
  const required = requiredConsumers(privateChanges, manifests)
  for (const id of pluginIDs) {
    const name = publicPackageName(id)
    if (changed.some((file) => file.startsWith(`plugins/${id}/src/`))) required.add(name)
    if (changed.includes(`plugins/${id}/package.json`)) {
      // The Changesets release PR itself changes versions after consuming its changesets.
      let previous: Manifest | undefined
      try { previous = JSON.parse(await git(root, ["show", `${ancestor}:plugins/${id}/package.json`])) } catch { /* New plugin. */ }
      const withoutVersion = (manifest: Manifest | undefined) => JSON.stringify(manifest && Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "version")))
      if (withoutVersion(previous) !== withoutVersion(manifests.get(name))) required.add(name)
    }
  }
  if (changed.includes("package.json")) {
    const previous: Manifest = JSON.parse(await git(root, ["show", `${ancestor}:package.json`]))
    const previousManifests = new Map<string, Manifest>()
    for (const [name, path] of manifestPaths) {
      try { previousManifests.set(name, JSON.parse(await git(root, ["show", `${ancestor}:${path}`]))) }
      catch { /* Newly introduced workspace: its current consumers already require a release. */ }
    }
    // Compare what each tarball actually declares, not just selected catalog entries.
    // This includes named catalogs, inherited dependencies, and host peer overrides,
    // while ignoring catalogs used only by tooling or unrelated private workspaces.
    const contract = (root: Manifest, plugin: Manifest, workspaces: Map<string, Manifest>) => {
      const dependencies = runtimeDependencies(root, plugin, new Map([...workspaces].filter(([, item]) => item.private)))
      return JSON.stringify(dependencyFields.map((field) => Object.entries(dependencies[field] ?? {}).sort(([left], [right]) => left.localeCompare(right))))
    }
    // A peer range alone can stay unchanged while the host singleton actually tested
    // against (the default catalog pin) moves; that still changes what consumers verify.
    const movedSingletons = hostSingletons(rootManifest).filter((name) => previous.workspaces?.catalog?.[name] !== rootManifest.workspaces?.catalog?.[name])
    for (const [name, manifest] of manifests) {
      if (manifest.private) continue
      const old = previousManifests.get(name)
      if (!old || contract(previous, old, previousManifests) !== contract(rootManifest, manifest, manifests)) required.add(name)
      if (movedSingletons.some((singleton) => manifest.peerDependencies?.[singleton])) required.add(name)
    }
  }
  // Every pending changeset must be valid, but only ones this change adds or edits
  // cover it: an older pending changeset already describes a different change.
  const pending = await validatePendingChangesets(root)
  const touched = new Set([
    ...lines(await git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=AM", ancestor, "--", ".changeset/"])),
    ...untracked.filter((file) => file.startsWith(".changeset/")),
  ].map((file) => file.slice(".changeset/".length)))
  assertReleaseCoverage(required, [...pending].filter(([file]) => touched.has(file)).flatMap(([, changes]) => changes))
  console.log(`Release policy passed (${required.size} affected plugins)`)
}

if (import.meta.main) await checkReleasePolicy(repositoryRoot, process.argv[2] ?? "origin/main")
