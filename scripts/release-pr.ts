import { pluginIDs, publicManifest, publicPackageName, repositoryRoot, run } from "./packaging"

export const previousInstructions = "When you're ready to do a release, you can merge this and publish to npm yourself or [setup this action to publish automatically](https://github.com/changesets/action#with-publishing)."
export const publishingInstructions = "Merging this PR makes the reviewed plugin versions eligible for automatic publishing by the separate publish job in release.yml, subject to the configured npm environment protections and validation. Obtain release approval before merging."

export interface ProposedRelease {
  name: string
  version: string
}

/** With github-api commit mode, Changesets leaves the proposed manifests in the
 * working tree. Compare against the workflow's starting SHA, not the release
 * branch, PR body, private workspace versions, or the npm registry.
 */
export async function proposedReleases(root = repositoryRoot, base: string): Promise<ProposedRelease[]> {
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error("Expected the workflow's starting commit SHA")
  const releases: ProposedRelease[] = []
  for (const id of pluginIDs) {
    const path = `plugins/${id}/package.json`
    const current = await publicManifest(root, id)
    const name = current.name
    if (typeof current.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(current.version)) {
      throw new Error(`Unexpected proposed version for ${name}`)
    }
    const previous = JSON.parse(await run(["git", "show", `${base}:${path}`], root).catch((error) => {
      throw new Error(`Cannot read ${path} at the workflow base: ${error.message}`)
    }))
    if (previous.name !== name || typeof previous.version !== "string") throw new Error(`Unexpected base manifest for ${name}`)
    if (current.version !== previous.version) releases.push({ name, version: current.version })
  }
  return releases
}

export function releasePRUpdate(body: unknown, releases: readonly ProposedRelease[]) {
  if (typeof body !== "string") throw new Error("Unexpected Changesets PR body")
  if (!body.includes(previousInstructions) && !body.includes(publishingInstructions)) {
    throw new Error("Expected Changesets publication instructions were not found")
  }
  if (!releases.length) throw new Error("Expected at least one changed public package")
  const id = (name: string) => {
    const match = pluginIDs.find((id) => publicPackageName(id) === name)
    if (!match) throw new Error(`Unexpected release package ${name}`)
    return match
  }
  const title = `chore(release): publish ${releases.map(({ name, version }) => `${id(name)}@${version}`).join(" ")}`
  return { title, body: body.replace(previousInstructions, publishingInstructions) }
}

if (import.meta.main) {
  const base = process.argv[2]
  if (!base) throw new Error("Usage: bun scripts/release-pr.ts <workflow-base-sha>")
  const pr = JSON.parse(await Bun.stdin.text())
  console.log(JSON.stringify(releasePRUpdate(pr.body, await proposedReleases(process.cwd(), base))))
}
