import { expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

test.each(["SIGINT", "SIGTERM"] as const)("host smoke confines its database and cleans up on %s", async (signal) => {
  const fixture = await mkdtemp(join(tmpdir(), "smoke-safety-"))
  const bin = join(fixture, "bin")
  const control = join(fixture, "started.json")
  let smoke: ReturnType<typeof Bun.spawn> | undefined
  let serverPID: number | undefined
  try {
    await mkdir(bin)
    await Bun.write(join(fixture, "package.json"), JSON.stringify({ name: "@lidtop/opencode-cost", exports: { ".": "./index.js" } }))
    await Bun.write(join(fixture, "index.js"), "throw new Error('Smoke identification must not evaluate the entrypoint'); export default { id: 'opcode-cost', setup() { throw new Error('Smoke identification must not call setup') } }")
    await Bun.write(join(bin, "opencode"), `#!${process.execPath}\nawait Bun.write(${JSON.stringify(control)}, JSON.stringify({ pid: process.pid, directory: process.cwd(), database: process.env.OPENCODE_DB }));\nsetInterval(() => {}, 1000);\n`)
    await chmod(join(bin, "opencode"), 0o700)
    const running = Bun.spawn([process.execPath, fileURLToPath(new URL("./host-smoke.ts", import.meta.url)), fixture], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENCODE_DB: join(fixture, "must-not-open.sqlite") },
      stdout: "pipe", stderr: "pipe",
    })
    smoke = running
    const output = Promise.all([new Response(running.stdout).text(), new Response(running.stderr).text()])
    const deadline = Date.now() + 5_000
    while (!await Bun.file(control).exists() && Date.now() < deadline && smoke.exitCode === null) await Bun.sleep(10)
    if (!await Bun.file(control).exists()) throw new Error(`Stub did not start; smoke exit ${smoke.exitCode}`)
    const started = await Bun.file(control).json() as { pid: number; directory: string; database: string }
    serverPID = started.pid
    expect(started.database).toBe(join(started.directory, "opencode.sqlite"))
    expect(started.database).not.toBe(join(fixture, "must-not-open.sqlite"))
    smoke.kill(signal)
    expect(await smoke.exited).toBe(signal === "SIGINT" ? 130 : 143)
    expect(await Bun.file(join(started.directory, "opencode.json")).exists()).toBe(false)
    expect(() => process.kill(started.pid, 0)).toThrow()
    expect(await output).toEqual(["", ""])
  } finally {
    if (smoke && smoke.exitCode === null) { smoke.kill("SIGKILL"); await smoke.exited }
    if (serverPID) {
      try { process.kill(serverPID, "SIGKILL") } catch { /* Already reaped by smoke cleanup. */ }
    }
    await rm(fixture, { recursive: true, force: true })
  }
}, 15_000)
