import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { manifestAt, pluginIDs, publicPackageName } from "../scripts/packaging"
import { publish, type PublishOperations } from "../scripts/publish"

const temporary: string[] = []
afterAll(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opcode-release-"))
  temporary.push(root)
  for (const [index, id] of pluginIDs.entries()) {
    const stage = join(root, ".release", `opcode-${id}`)
    await mkdir(stage, { recursive: true })
    await writeFile(join(stage, "package.json"), JSON.stringify({ name: publicPackageName(id), version: `${index + 1}.2.3` }))
  }
  const commands: string[][] = []
  const lookups: string[] = []
  const published: string[] = []
  const statuses = new Map<string, number>()
  let builds = 0
  const operations: PublishOperations = {
    environment: { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid" },
    build: async () => { builds++ },
    registryStatus: async (url) => {
      lookups.push(url)
      return statuses.get(url) ?? 404
    },
    command: async (args, cwd) => {
      commands.push(args)
      if (args[0] === "npm" && args[1] === "--version") return "11.6.2\n"
      if (args[0] === "node" && args[1] === "--version") return "v24.1.0\n"
      const manifest = await manifestAt(cwd)
      if (args[0] === "npm" && args[1] === "pack") return JSON.stringify([{ filename: `packed-${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz` }])
      if (args[0] === "npm" && args[1] === "publish") {
        published.push(`${manifest.name}@${manifest.version}`)
        statuses.set(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`, 200)
        return "Published (test double only)"
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`)
    },
  }
  return { root, operations, commands, lookups, published, statuses, builds: () => builds }
}

describe("publish safety (all external operations injected; no network or publishing)", () => {
  test("dry-run only builds and packs, without registry lookups or publish commands", async () => {
    const run = await fixture()
    expect(await publish(run.root, false, { ...run.operations, environment: {} })).toEqual([])
    expect(run.builds()).toBe(1)
    expect(run.commands.map((args) => args.slice(0, 2))).toEqual(pluginIDs.map(() => ["npm", "pack"]))
    expect(run.lookups).toEqual([])
    expect(run.published).toEqual([])
  })

  test("checks exact versions, skips existing ones, and publishes only 404 results", async () => {
    const run = await fixture()
    run.statuses.set("https://registry.npmjs.org/%40lidtop%2Fopencode-context/1.2.3", 200)
    const result = await publish(run.root, true, run.operations)
    expect(run.lookups).toEqual(pluginIDs.map((id, index) => `https://registry.npmjs.org/%40lidtop%2Fopencode-${id}/${index + 1}.2.3`))
    expect(run.published).toEqual(["@lidtop/opencode-cost@2.2.3", "@lidtop/opencode-later@3.2.3", "@lidtop/opencode-sessions@4.2.3"])
    expect(result.map(({ name, version }) => `${name}@${version}`)).toEqual(run.published)
    const publishCommands = run.commands.filter((command) => command[1] === "publish")
    expect(publishCommands.map((args) => args[2])).toEqual([
      join(run.root, ".release/tarballs/packed-lidtop-opencode-cost-2.2.3.tgz"),
      join(run.root, ".release/tarballs/packed-lidtop-opencode-later-3.2.3.tgz"),
      join(run.root, ".release/tarballs/packed-lidtop-opencode-sessions-4.2.3.tgz"),
    ])
    for (const args of publishCommands) {
      expect(args).toContain("--ignore-scripts")
      expect(args).toContain("--provenance")
    }
  })

  test("registry failures and transport errors fail closed", async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const run = await fixture()
      run.statuses.set("https://registry.npmjs.org/%40lidtop%2Fopencode-context/1.2.3", status)
      await expect(publish(run.root, true, run.operations)).rejects.toThrow(`HTTP ${status}`)
      expect(run.published).toEqual([])
      expect(run.lookups).toHaveLength(1)
    }
    const run = await fixture()
    await expect(publish(run.root, true, { ...run.operations, registryStatus: async () => { throw new Error("connection failed") } })).rejects.toThrow("connection failed")
    expect(run.published).toEqual([])
  })

  test("partial-release retries skip successful versions and resume the remaining packages", async () => {
    const run = await fixture()
    run.statuses.set("https://registry.npmjs.org/%40lidtop%2Fopencode-cost/2.2.3", 503)
    await expect(publish(run.root, true, run.operations)).rejects.toThrow("HTTP 503")
    expect(run.published).toEqual(["@lidtop/opencode-context@1.2.3"])
    run.statuses.delete("https://registry.npmjs.org/%40lidtop%2Fopencode-cost/2.2.3")
    const retry = await publish(run.root, true, run.operations)
    expect(run.published).toEqual(["@lidtop/opencode-context@1.2.3", "@lidtop/opencode-cost@2.2.3", "@lidtop/opencode-later@3.2.3", "@lidtop/opencode-sessions@4.2.3"])
    expect(retry.map(({ name }) => name)).toEqual(["@lidtop/opencode-cost", "@lidtop/opencode-later", "@lidtop/opencode-sessions"])
  })

  test("invalid live environments fail before commands, builds, registry access, or publishing", async () => {
    const run = await fixture()
    for (const environment of [
      {},
      { ...run.operations.environment, GITHUB_ACTIONS: "false" },
      { ...run.operations.environment, GITHUB_REF: "refs/heads/feature" },
      { ...run.operations.environment, ACTIONS_ID_TOKEN_REQUEST_URL: undefined },
    ]) {
      await expect(publish(run.root, true, { ...run.operations, environment })).rejects.toThrow("main-branch GitHub Actions OIDC")
    }
    expect(run.builds()).toBe(0)
    expect(run.commands).toEqual([])
    expect(run.lookups).toEqual([])
    expect(run.published).toEqual([])
  })

  test("unsupported toolchains fail before build, registry access, or publishing", async () => {
    for (const [tool, version] of [["npm", "11.5.0"], ["npm", "10.9.0"], ["npm", "11.invalid"], ["node", "v22.14.0"], ["node", "v24.invalid"]]) {
      const run = await fixture()
      await expect(publish(run.root, true, {
        ...run.operations,
        command: (args, cwd) => args[0] === tool && args[1] === "--version" ? Promise.resolve(version!) : run.operations.command(args, cwd),
      })).rejects.toThrow("Publishing requires")
      expect(run.builds()).toBe(0)
      expect(run.lookups).toEqual([])
      expect(run.published).toEqual([])
    }
  })
})
