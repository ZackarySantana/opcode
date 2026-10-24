import { afterAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { globalConfigFiles, suspendPublished } from "../scripts/dev"
import { prod } from "../scripts/prod"

const temporary: string[] = []
afterAll(async () => { for (const root of temporary) await rm(root, { recursive: true, force: true }) })

/** A checkout whose global config already has Cost pinned, Context with options, and Feed CLI-only. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opcode-prod-test-"))
  temporary.push(root)
  await mkdir(join(root, "opencode"))
  const files = { server: join(root, "opencode", "opencode.jsonc"), cli: join(root, "opencode", "cli.json") }
  const original = {
    server: `// pinned and configured copies
{ "plugins": ["@lidtop/opencode-cost@0.2.3", { "package": "@lidtop/opencode-context", "options": {} }, "another-plugin"] }
`,
    cli: JSON.stringify({ plugins: ["@lidtop/opencode-feed"] }),
  }
  await Bun.write(files.server, original.server)
  await Bun.write(files.cli, original.cli)
  const calls: string[] = []
  const opencode = async (args: string[]) => { calls.push(args.join(" ")); return 0 }
  return { root, environment: { XDG_CONFIG_HOME: root }, files, original, calls, opencode, lock: join(root, ".release/dev/config/pid") }
}

// Configured plugins are updated in place; only Later, Sessions, GH PR Status, and Snippets are added.
const expected = ["plugin update", "plugin add @lidtop/opencode-later", "plugin add @lidtop/opencode-sessions", "plugin add @lidtop/opencode-gh-pr-status", "plugin add @lidtop/opencode-snippets"]

test("prod updates plugins, then installs only those global config lacks, whatever version, options, or file the others use", async () => {
  const { root, environment, files, original, calls, opencode, lock } = await fixture()
  expect(await prod([], root, environment, opencode)).toBe(0)
  expect(calls).toEqual(expected)
  expect(await Bun.file(files.server).text()).toBe(original.server)
  expect(await Bun.file(files.cli).text()).toBe(original.cli)
  expect(await Bun.file(lock).exists()).toBe(false)
  calls.length = 0
  expect(await prod(["feed", "later"], root, environment, opencode)).toBe(0)
  expect(calls).toEqual(["plugin update", "plugin add @lidtop/opencode-later"])
})

test("prod puts back what a killed preview took out instead of installing second copies", async () => {
  const { root, environment, files, original, calls, opencode } = await fixture()
  await suspendPublished(globalConfigFiles(environment), ["@lidtop/opencode-cost", "@lidtop/opencode-feed"], join(root, ".release/dev/config"))
  expect(await Bun.file(files.cli).json()).toEqual({ plugins: [] })
  expect(await prod([], root, environment, opencode)).toBe(0)
  expect(await Bun.file(files.server).text()).toBe(original.server)
  expect(await Bun.file(files.cli).text()).toBe(original.cli)
  expect(calls).toEqual(expected)
})

test("prod refuses while a running preview holds global config", async () => {
  const { root, environment, calls, opencode, lock } = await fixture()
  const preview = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"])
  try {
    await mkdir(join(root, ".release/dev/config"), { recursive: true })
    await Bun.write(lock, String(preview.pid))
    await expect(prod([], root, environment, opencode)).rejects.toThrow(`PID ${preview.pid}`)
    expect(calls).toEqual([])
    expect(await Bun.file(lock).text()).toBe(String(preview.pid))
  } finally { preview.kill() }
})

test("a failed command stops prod with its status and gives global config back", async () => {
  const { root, environment, lock } = await fixture()
  const calls: string[] = []
  expect(await prod([], root, environment, async (args) => { calls.push(args.join(" ")); return args[1] === "add" ? 1 : 0 })).toBe(1)
  expect(calls).toEqual(expected.slice(0, 2))
  expect(await Bun.file(lock).exists()).toBe(false)
})
