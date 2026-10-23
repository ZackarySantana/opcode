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
  const installed: string[] = []
  const install = async (name: string) => { installed.push(name); return 0 }
  return { root, environment: { XDG_CONFIG_HOME: root }, files, original, installed, install, lock: join(root, ".release/dev/config/pid") }
}

const missing = ["@lidtop/opencode-later", "@lidtop/opencode-sessions", "@lidtop/opencode-gh-pr-status"]

test("prod installs only the plugins global config lacks, whatever version, options, or file the others use", async () => {
  const { root, environment, files, original, installed, install, lock } = await fixture()
  expect(await prod([], root, environment, install)).toBe(0)
  expect(installed).toEqual(missing)
  expect(await Bun.file(files.server).text()).toBe(original.server)
  expect(await Bun.file(files.cli).text()).toBe(original.cli)
  expect(await Bun.file(lock).exists()).toBe(false)
  installed.length = 0
  expect(await prod(["feed", "later"], root, environment, install)).toBe(0)
  expect(installed).toEqual(["@lidtop/opencode-later"])
})

test("prod puts back what a killed preview took out instead of installing second copies", async () => {
  const { root, environment, files, original, installed, install } = await fixture()
  await suspendPublished(globalConfigFiles(environment), ["@lidtop/opencode-cost", "@lidtop/opencode-feed"], join(root, ".release/dev/config"))
  expect(await Bun.file(files.cli).json()).toEqual({ plugins: [] })
  expect(await prod([], root, environment, install)).toBe(0)
  expect(await Bun.file(files.server).text()).toBe(original.server)
  expect(await Bun.file(files.cli).text()).toBe(original.cli)
  expect(installed).toEqual(missing)
})

test("prod refuses while a running preview holds global config", async () => {
  const { root, environment, installed, install, lock } = await fixture()
  const preview = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"])
  try {
    await mkdir(join(root, ".release/dev/config"), { recursive: true })
    await Bun.write(lock, String(preview.pid))
    await expect(prod([], root, environment, install)).rejects.toThrow(`PID ${preview.pid}`)
    expect(installed).toEqual([])
    expect(await Bun.file(lock).text()).toBe(String(preview.pid))
  } finally { preview.kill() }
})

test("a failed install stops prod with its status and gives global config back", async () => {
  const { root, environment, lock } = await fixture()
  const attempted: string[] = []
  expect(await prod([], root, environment, async (name) => { attempted.push(name); return 1 })).toBe(1)
  expect(attempted).toEqual(missing.slice(0, 1))
  expect(await Bun.file(lock).exists()).toBe(false)
})
