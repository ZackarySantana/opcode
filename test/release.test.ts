import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { manifestAt, pluginIDs, publicPackageName, run as exec } from "../scripts/packaging"
import { pack, publishTarballs, unpublished, type PublishOperations } from "../scripts/publish"

const temporary: string[] = []
afterAll(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true })
})

// The fixture gives each plugin version <position + 1>.2.3, and context is already published in most tests.
const releases = pluginIDs.map((id, index) => ({ id, name: publicPackageName(id), version: `${index + 1}.2.3` }))
const afterContext = releases.slice(1)

async function temp(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(directory)
  return directory
}

/** Real npm-style tarballs (package/package.json) in an artifact directory. */
async function tarball(directory: string, manifest: object, file = `${crypto.randomUUID()}.tgz`) {
  const source = await temp("opcode-tarball-")
  await mkdir(join(source, "package"))
  await writeFile(join(source, "package/package.json"), JSON.stringify(manifest))
  await exec(["tar", "-czf", join(directory, file), "-C", source, "package"], source)
  return join(directory, file)
}

async function fixture() {
  const root = await temp("opcode-release-")
  const artifacts = join(root, "artifacts")
  await mkdir(artifacts)
  for (const [index, id] of pluginIDs.entries()) {
    const stage = join(root, ".release", `opcode-${id}`)
    await mkdir(stage, { recursive: true })
    await writeFile(join(stage, "package.json"), JSON.stringify({ name: publicPackageName(id), version: `${index + 1}.2.3` }))
    await tarball(artifacts, { name: publicPackageName(id), version: `${index + 1}.2.3` }, `lidtop-opencode-${id}-${index + 1}.2.3.tgz`)
  }
  const commands: string[][] = []
  const lookups: string[] = []
  const published: string[] = []
  const statuses = new Map<string, number>()
  const sleeps: number[] = []
  const publishFailures: Array<{ name: string; error: string; lands?: boolean }> = []
  let builds = 0
  const operations: PublishOperations = {
    environment: { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid" },
    build: async () => { builds++ },
    sleep: async (ms) => { sleeps.push(ms) },
    registryStatus: async (url) => {
      lookups.push(url)
      return statuses.get(url) ?? 404
    },
    command: async (args, cwd) => {
      commands.push(args)
      if (args[0] === "tar") return exec(args, cwd)
      if (args[0] === "npm" && args[1] === "--version") return "11.6.2\n"
      if (args[0] === "node" && args[1] === "--version") return "v24.1.0\n"
      if (args[0] === "npm" && args[1] === "pack") {
        const manifest = await manifestAt(cwd)
        return JSON.stringify([{ filename: `packed-${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz` }])
      }
      if (args[0] === "npm" && args[1] === "publish") {
        const manifest = JSON.parse(await exec(["tar", "-xzOf", args[2]!, "package/package.json"], cwd))
        const failure = publishFailures.findIndex((item) => item.name === manifest.name)
        if (failure >= 0) {
          const [{ error, lands }] = publishFailures.splice(failure, 1) as [typeof publishFailures[number]]
          if (lands) statuses.set(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`, 200)
          throw new Error(`npm publish failed: ${error}`)
        }
        published.push(`${manifest.name}@${manifest.version}`)
        statuses.set(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`, 200)
        return "Published (test double only)"
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`)
    },
  }
  const npmCommands = () => commands.filter((args) => args[0] === "npm")
  return { root, artifacts, operations, commands, npmCommands, lookups, published, statuses, sleeps, publishFailures, builds: () => builds }
}

describe("publish safety (all external operations injected; no network or publishing)", () => {
  test("dry-run only builds and packs fresh tarballs, without registry lookups or publish commands", async () => {
    const run = await fixture()
    await mkdir(join(run.root, ".release/tarballs"))
    await writeFile(join(run.root, ".release/tarballs/stale-0.0.1.tgz"), "")
    const packed = await pack(run.root, { ...run.operations, environment: {} })
    expect(packed.map(({ name }) => name)).toEqual(pluginIDs.map(publicPackageName))
    expect(run.builds()).toBe(1)
    expect(run.commands.map((args) => args.slice(0, 2))).toEqual(pluginIDs.map(() => ["npm", "pack"]))
    expect(run.lookups).toEqual([])
    expect(run.published).toEqual([])
    expect(await Bun.file(join(run.root, ".release/tarballs/stale-0.0.1.tgz")).exists()).toBe(false)
  })

  test("pending versions are computed read-only from tarball manifests and exposed as a step output", async () => {
    const run = await fixture()
    run.statuses.set("https://registry.npmjs.org/%40lidtop%2Fopencode-context/1.2.3", 200)
    const output = join(run.root, "github-output")
    const pending = await unpublished(run.artifacts, { ...run.operations, environment: { GITHUB_OUTPUT: output } })
    expect(pending.map(({ name }) => name)).toEqual(afterContext.map(({ name }) => name))
    expect(await readFile(output, "utf8")).toBe(`packages=${JSON.stringify(afterContext.map(({ name, version }) => `${name}@${version}`))}\n`)
    expect(run.npmCommands()).toEqual([])
    expect(run.published).toEqual([])

    for (const id of pluginIDs.slice(1)) run.statuses.set(`https://registry.npmjs.org/%40lidtop%2Fopencode-${id}/${pluginIDs.indexOf(id) + 1}.2.3`, 200)
    await unpublished(run.artifacts, { ...run.operations, environment: { GITHUB_OUTPUT: output } })
    expect((await readFile(output, "utf8")).trim().split("\n").at(-1)).toBe("packages=[]")
  })

  test("publishes prebuilt tarballs without building, skipping existing exact versions", async () => {
    const run = await fixture()
    run.statuses.set("https://registry.npmjs.org/%40lidtop%2Fopencode-context/1.2.3", 200)
    const result = await publishTarballs(run.artifacts, run.operations)
    expect(run.builds()).toBe(0)
    expect(run.lookups).toEqual(pluginIDs.map((id, index) => `https://registry.npmjs.org/%40lidtop%2Fopencode-${id}/${index + 1}.2.3`))
    expect(run.published).toEqual(afterContext.map(({ name, version }) => `${name}@${version}`))
    expect(result.map(({ name, version }) => `${name}@${version}`)).toEqual(run.published)
    const publishCommands = run.commands.filter((command) => command[1] === "publish")
    expect(publishCommands.map((args) => args[2])).toEqual(afterContext.map(({ id, version }) => join(run.artifacts, `lidtop-opencode-${id}-${version}.tgz`)))
    for (const args of publishCommands) {
      expect(args).toContain("--ignore-scripts")
      expect(args).toContain("--provenance")
    }
  })

  test("unexpected, duplicate, or missing tarballs fail before any registry access or publishing", async () => {
    for (const change of [
      async (directory: string) => { await tarball(directory, { name: "@opcode/core", version: "0.0.0" }) },
      async (directory: string) => { await tarball(directory, { name: publicPackageName("cost"), version: "9.9.9" }) },
      async (directory: string) => { await tarball(directory, { name: publicPackageName("later"), version: "3.2.3", private: true }) },
      async (directory: string) => { await rm(join(directory, "lidtop-opencode-sessions-4.2.3.tgz")) },
    ]) {
      const run = await fixture()
      await change(run.artifacts)
      await expect(publishTarballs(run.artifacts, run.operations)).rejects.toThrow(/Unexpected package|Multiple tarballs|Missing tarball/)
      await expect(unpublished(run.artifacts, run.operations)).rejects.toThrow(/Unexpected package|Multiple tarballs|Missing tarball/)
      expect(run.lookups).toEqual([])
      expect(run.published).toEqual([])
    }
  })

  test("registry failures and transport errors fail closed", async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const run = await fixture()
      run.statuses.set("https://registry.npmjs.org/%40lidtop%2Fopencode-context/1.2.3", status)
      await expect(publishTarballs(run.artifacts, run.operations)).rejects.toThrow(`HTTP ${status}`)
      await expect(unpublished(run.artifacts, run.operations)).rejects.toThrow(`HTTP ${status}`)
      expect(run.published).toEqual([])
    }
    const run = await fixture()
    await expect(publishTarballs(run.artifacts, { ...run.operations, registryStatus: async () => { throw new Error("connection failed") } })).rejects.toThrow("connection failed")
    expect(run.published).toEqual([])
  })

  test("transient registry failures retry with backoff, and a PUT that landed is not republished", async () => {
    const run = await fixture()
    const unavailable = "npm error code E503\nnpm error 503 Service Unavailable - PUT https://registry.npmjs.org/x"
    run.publishFailures.push(
      { name: publicPackageName("context"), error: unavailable },
      { name: publicPackageName("context"), error: "npm error code ECONNRESET" },
      { name: publicPackageName("cost"), error: unavailable, lands: true },
    )
    await publishTarballs(run.artifacts, run.operations)
    expect(run.sleeps).toEqual([5_000, 15_000])
    expect(run.published).toEqual(releases.filter(({ id }) => id !== "cost").map(({ name, version }) => `${name}@${version}`))
    expect(run.commands.filter((args) => args[1] === "publish" && args[2]!.includes("opencode-cost"))).toHaveLength(1)
  })

  test("non-transient publish errors and exhausted retries fail without further attempts", async () => {
    const auth = await fixture()
    auth.publishFailures.push({ name: publicPackageName("context"), error: "npm error code E403\nnpm error 403 Forbidden" })
    await expect(publishTarballs(auth.artifacts, auth.operations)).rejects.toThrow("E403")
    expect(auth.sleeps).toEqual([])
    expect(auth.published).toEqual([])
    const outage = await fixture()
    for (let attempt = 0; attempt < 3; attempt++) outage.publishFailures.push({ name: publicPackageName("context"), error: "npm error code E503" })
    await expect(publishTarballs(outage.artifacts, outage.operations)).rejects.toThrow("E503")
    expect(outage.sleeps).toEqual([5_000, 15_000])
    expect(outage.published).toEqual([])
  })

  test("partial-release retries skip successful versions and resume the remaining packages", async () => {
    const run = await fixture()
    run.statuses.set("https://registry.npmjs.org/%40lidtop%2Fopencode-cost/2.2.3", 503)
    await expect(publishTarballs(run.artifacts, run.operations)).rejects.toThrow("HTTP 503")
    expect(run.published).toEqual(["@lidtop/opencode-context@1.2.3"])
    run.statuses.delete("https://registry.npmjs.org/%40lidtop%2Fopencode-cost/2.2.3")
    const retry = await publishTarballs(run.artifacts, run.operations)
    expect(run.published).toEqual(releases.map(({ name, version }) => `${name}@${version}`))
    expect(retry.map(({ name }) => name)).toEqual(afterContext.map(({ name }) => name))
  })

  test("invalid live environments fail before commands, registry access, or publishing", async () => {
    const run = await fixture()
    for (const environment of [
      {},
      { ...run.operations.environment, GITHUB_ACTIONS: "false" },
      { ...run.operations.environment, GITHUB_REF: "refs/heads/feature" },
      { ...run.operations.environment, ACTIONS_ID_TOKEN_REQUEST_URL: undefined },
    ]) {
      await expect(publishTarballs(run.artifacts, { ...run.operations, environment })).rejects.toThrow("main-branch GitHub Actions OIDC")
    }
    expect(run.commands).toEqual([])
    expect(run.lookups).toEqual([])
    expect(run.published).toEqual([])
  })

  test("unsupported toolchains fail before registry access or publishing", async () => {
    for (const [tool, version] of [["npm", "11.5.0"], ["npm", "10.9.0"], ["npm", "11.invalid"], ["node", "v22.14.0"], ["node", "v24.invalid"]]) {
      const run = await fixture()
      await expect(publishTarballs(run.artifacts, {
        ...run.operations,
        command: (args, cwd) => args[0] === tool && args[1] === "--version" ? Promise.resolve(version!) : run.operations.command(args, cwd),
      })).rejects.toThrow("Publishing requires")
      expect(run.lookups).toEqual([])
      expect(run.published).toEqual([])
    }
  })
})
