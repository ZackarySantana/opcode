import { afterAll, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pluginIDs, publicPackageName, repositoryRoot } from "../scripts/packaging"
import { previousInstructions, proposedReleases, publishingInstructions, releasePRUpdate } from "../scripts/release-pr"

const temporary: string[] = []
afterAll(async () => { for (const root of temporary) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opcode-release-pr-"))
  temporary.push(root)
  const manifest = async (id: typeof pluginIDs[number], version: string, extra = {}) => {
    const directory = join(root, "plugins", id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: publicPackageName(id), version, ...extra }))
  }
  await Promise.all(pluginIDs.map((id) => manifest(id, "0.1.0")))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "opcode", private: true, version: "99.0.0" }))
  await mkdir(join(root, "packages/ui"), { recursive: true })
  await writeFile(join(root, "packages/ui/package.json"), JSON.stringify({ name: "@opcode/ui", private: true, version: "0.0.0" }))
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (status) throw new Error(stderr)
    return stdout.trim()
  }
  await git("init", "-b", "main")
  await git("add", ".")
  await git("-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "commit", "-m", "fixture")
  return { root, manifest, base: await git("rev-parse", "HEAD") }
}

test("titles use only changed public package versions, never the root or bundled workspaces", async () => {
  const f = await fixture()
  await f.manifest("cost", "0.2.1")
  await f.manifest("context", "0.1.1")
  await writeFile(join(f.root, "package.json"), JSON.stringify({ name: "opcode", private: true, version: "100.0.0" }))
  await writeFile(join(f.root, "packages/ui/package.json"), JSON.stringify({ name: "@opcode/ui", private: true, version: "50.0.0" }))
  const releases = await proposedReleases(f.root, f.base)
  expect(releases).toEqual([{ name: publicPackageName("context"), version: "0.1.1" }, { name: publicPackageName("cost"), version: "0.2.1" }])
  expect(releasePRUpdate(previousInstructions, releases).title).toBe("chore(release): publish context@0.1.1 cost@0.2.1")
})

test("every independent release is listed, including proposed prerelease versions", async () => {
  const f = await fixture()
  for (const [index, id] of pluginIDs.entries()) await f.manifest(id, `0.${index + 2}.0${id === "sessions" ? "-beta.2" : ""}`)
  expect(releasePRUpdate(previousInstructions, await proposedReleases(f.root, f.base)).title)
    .toBe("chore(release): publish context@0.2.0 cost@0.3.0 later@0.4.0 sessions@0.5.0-beta.2 feed@0.6.0 gh-pr-status@0.7.0")
})

test("body updates preserve all release notes and are idempotent", () => {
  const releases = [{ name: publicPackageName("later"), version: "0.1.1" }]
  const notes = "\n\n# Releases\n## @lidtop/opencode-later@0.1.1\n\n- Keep **Markdown**, quotes, and Unicode → intact.\n"
  const body = `This PR was opened by Changesets. ${previousInstructions} More changesets update it.${notes}`
  const update = releasePRUpdate(body, releases)
  expect(update.title).toBe("chore(release): publish later@0.1.1")
  expect(update.body).toBe(body.replace(previousInstructions, publishingInstructions))
  expect(update.body.endsWith(notes)).toBe(true)
  expect(releasePRUpdate(update.body, releases)).toEqual(update)
  expect(() => releasePRUpdate(null, releases)).toThrow("Unexpected Changesets PR body")
  expect(() => releasePRUpdate("Unrecognized body", releases)).toThrow("publication instructions")
  expect(() => releasePRUpdate(body, [])).toThrow("changed public package")
})

test("invalid package metadata and unavailable base commits fail closed", async () => {
  const f = await fixture()
  expect(await proposedReleases(f.root, f.base)).toEqual([])
  await expect(proposedReleases(f.root, "main")).rejects.toThrow("starting commit SHA")
  await expect(proposedReleases(f.root, "0".repeat(40))).rejects.toThrow("workflow base")
  await f.manifest("context", "0.1.1", { private: true })
  await expect(proposedReleases(f.root, f.base)).rejects.toThrow("Expected public package")
  await f.manifest("context", "0.1.1", { name: "opcode" })
  await expect(proposedReleases(f.root, f.base)).rejects.toThrow("Expected public package")
  for (const version of ["", "1.2", "0.1.1\ninjected title"]) {
    await f.manifest("context", version)
    await expect(proposedReleases(f.root, f.base)).rejects.toThrow("Unexpected proposed version")
  }
})

test("actual post-Changesets workflow PATCHes title and body on creation and regeneration without network access", async () => {
  const f = await fixture()
  await symlink(join(repositoryRoot, "scripts"), join(f.root, "scripts"), "dir")
  await mkdir(join(f.root, "bin"))
  const gh = join(f.root, "bin/gh")
  const prFile = join(f.root, "pr.json")
  const requests = join(f.root, "requests.jsonl")
  await writeFile(gh, `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises"
const args = process.argv.slice(2)
const endpoint = "repos/test/opcode/pulls/123"
if (args[0] !== "api" || !args.includes(endpoint)) throw new Error("Unexpected API endpoint")
if (args.includes("PATCH")) {
  if (!args.includes("--input") || !args.includes("-") || !args.includes("--silent")) throw new Error("Expected JSON patch")
  const patch = JSON.parse(await Bun.stdin.text())
  if (typeof patch.title !== "string" || typeof patch.body !== "string") throw new Error("Expected both title and body")
  await appendFile(process.env.REQUESTS, JSON.stringify(patch) + "\\n")
  await Bun.write(process.env.PR_FILE, JSON.stringify({ ...await Bun.file(process.env.PR_FILE).json(), ...patch }))
} else {
  process.stdout.write(await Bun.file(process.env.PR_FILE).text())
}
`)
  await chmod(gh, 0o700)
  // Keep the workflow adapter hermetic: forward its mise invocation to the Bun
  // already running this test, rather than discovering tools in a temp checkout.
  const mise = join(f.root, "bin/mise")
  await writeFile(mise, `#!/usr/bin/env bun
const args = process.argv.slice(2)
if (args.slice(0, 3).join(" ") !== "exec -- bun") throw new Error("Unexpected tool invocation")
const child = Bun.spawn([process.execPath, ...args.slice(3)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
process.exit(await child.exited)
`)
  await chmod(mise, 0o700)
  const workflow = Bun.YAML.parse(await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8")) as {
    jobs: { version: { steps: { id?: string; run?: string }[] } }
  }
  const step = workflow.jobs.version.steps.find((step) => step.id === "release-pr")
  if (!step?.run) throw new Error("Missing release PR update command")
  const run = async () => {
    const child = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", step.run!], {
      cwd: f.root, stdout: "pipe", stderr: "pipe", env: {
        ...process.env, PATH: `${join(f.root, "bin")}:${dirname(process.execPath)}:${process.env.PATH}`,
        GH_TOKEN: "test-only", GITHUB_REPOSITORY: "test/opcode", PR_NUMBER: "123", BASE_SHA: f.base,
        PR_FILE: prFile, REQUESTS: requests,
      },
    })
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (status) throw new Error(`Workflow failed: ${stdout}\n${stderr}`)
  }
  await f.manifest("context", "0.1.1")
  const notes = "\n\n# Releases\n## @lidtop/opencode-context@0.1.1\n\n- Restore color.\n"
  await writeFile(prFile, JSON.stringify({ title: "chore(release): publish plugins", body: previousInstructions + notes }))
  await run()
  expect(await Bun.file(prFile).json()).toEqual({ title: "chore(release): publish context@0.1.1", body: publishingInstructions + notes })

  // Changesets regenerates the default title/body as new changesets arrive.
  await f.manifest("cost", "0.2.1")
  const regeneratedNotes = notes + "\n## @lidtop/opencode-cost@0.2.1\n\n- New cost fix.\n"
  await writeFile(prFile, JSON.stringify({ title: "chore(release): publish plugins", body: previousInstructions + regeneratedNotes }))
  await run()
  const result = await Bun.file(prFile).json()
  expect(result).toEqual({ title: "chore(release): publish context@0.1.1 cost@0.2.1", body: publishingInstructions + regeneratedNotes })
  const patches = (await readFile(requests, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  expect(patches).toHaveLength(2)
  expect(patches[1]).toEqual(result)
})
