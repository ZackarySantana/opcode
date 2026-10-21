import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { dependencyFields, manifestAt, pluginIDs, privateWorkspaces, publicPackageName, repositoryRoot, runtimeDependencies, type Manifest } from "./packaging"

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

async function git(root: string, args: string[]) {
  const process = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (status) throw new Error(`git ${args[0]} failed: ${stderr}`)
  return stdout.trimEnd()
}

export async function checkReleasePolicy(root = repositoryRoot, base = "origin/main") {
  const rootManifest = await manifestAt(root)
  const catalog = rootManifest.workspaces?.catalog ?? {}
  const openCodeVersions = Object.entries(catalog).filter(([name]) => name.startsWith("@opencode/")).map(([, version]) => version)
  if (new Set(openCodeVersions).size > 1) throw new Error("All @opencode/* catalog versions must move together")
  const ancestor = await git(root, ["merge-base", base, "HEAD"])
  const changed = (await git(root, ["diff", "--name-only", ancestor, "HEAD"])).split("\n")
  const privateMap = await privateWorkspaces(root)
  const manifests = new Map([...privateMap].map(([name, workspace]) => [name, workspace.manifest]))
  const manifestPaths = new Map([...privateMap].map(([name, workspace]) => [name, `${relative(root, workspace.directory)}/package.json`]))
  for (const id of pluginIDs) {
    const directory = join(root, "plugins", id)
    const manifest = await manifestAt(directory)
    if (manifest.name !== publicPackageName(id) || manifest.private) throw new Error(`Invalid public plugin manifest: ${directory}`)
    manifests.set(manifest.name, manifest)
    manifestPaths.set(manifest.name, `plugins/${id}/package.json`)
  }
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
    for (const [name, manifest] of manifests) {
      if (manifest.private) continue
      const old = previousManifests.get(name)
      if (!old || contract(previous, old, previousManifests) !== contract(rootManifest, manifest, manifests)) required.add(name)
    }
  }
  const changes: ReleaseChange[] = []
  for (const file of await readdir(join(root, ".changeset"))) {
    if (file.endsWith(".md") && file !== "README.md") changes.push(...parseChangeset(await readFile(join(root, ".changeset", file), "utf8")))
  }
  for (const change of changes) {
    const manifest = manifests.get(change.name)
    if (!manifest || manifest.private) throw new Error(`Changesets must name public plugins, not ${change.name}`)
  }
  assertReleaseCoverage(required, changes)
  console.log(`Release policy passed (${required.size} affected plugins)`)
}

if (import.meta.main) await checkReleasePolicy(repositoryRoot, process.argv[2] ?? "origin/main")
