/** Optional real-keyboard check. Uses a PTY and entirely separate core/plugin databases. */
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareDev } from "../scripts/dev"
import { repositoryRoot, pluginIDs } from "../scripts/packaging"
import { Terminal as HeadlessTerminal } from "@xterm/headless"
import { Database } from "bun:sqlite"

const executable = Bun.which("opencode")
if (!executable) throw new Error("OpenCode V2 is required for the interactive smoke check")
await mkdir(tmpdir(), { recursive: true })
const root = await mkdtemp(join(tmpdir(), "tui-smoke-"))
let child: ReturnType<typeof Bun.spawn> | undefined
let output = ""
const shutdown = new AbortController()
let cleanupTask: Promise<void> | undefined
const decoder = new TextDecoder()
const size = { cols: 110, rows: 36 }
const display = new HeadlessTerminal({ ...size, allowProposedApi: true })
const frame = () => Array.from({ length: display.rows }, (_, row) => display.buffer.active.getLine(display.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n")
const terminal = new Bun.Terminal({ ...size, data: (_terminal, data) => {
  output += decoder.decode(data, { stream: true })
  display.write(data)
} })
const replies = display.onData((data) => { if (!terminal.closed) terminal.write(data) })
const cleanup = () => cleanupTask ??= (async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    const force = setTimeout(() => { if (child?.exitCode === null) child.kill("SIGKILL") }, 5_000)
    try { await child.exited } finally { clearTimeout(force) }
  }
  terminal.close()
  replies.dispose()
  display.dispose()
  await rm(root, { recursive: true, force: true })
})()
const interrupt = (status: number) => {
  shutdown.abort(new Error("Interactive smoke check interrupted"))
  process.exitCode = status
  void cleanup().catch((error) => { console.error(error); process.exitCode = 1 })
}
const onInterrupt = () => interrupt(130)
const onTerminate = () => interrupt(143)
process.on("SIGINT", onInterrupt)
process.on("SIGTERM", onTerminate)
const wait = async (text: string, from = output.length, timeout = 8_000, absent?: string) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted()
    const current = frame()
    if (output.length > from && current.includes(text) && (!absent || !current.includes(absent))) return true
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`OpenCode exited (${child.exitCode})`)
    await Bun.sleep(25)
  }
  return false
}
const requireText = async (text: string, from = output.length, absent?: string) => {
  if (!await wait(text, from, 8_000, absent)) throw new Error(`Keyboard smoke: expected '${text}'${absent ? ` without '${absent}'` : ""}\n${frame()}`)
}
const key = async (input: string, expected: string, absent?: string) => {
  const from = output.length
  terminal.write(input)
  await requireText(expected, from, absent)
}
const open = async (name: string, title: string) => {
  const from = output.length
  terminal.write(`/${name}`)
  await requireText(`/${name}`, from)
  const entered = output.length
  terminal.write("\r")
  // First Enter accepts slash completion on hosts where it does not execute yet.
  if (!await wait(title, entered, 700)) terminal.write("\r")
  await requireText(title, entered)
}
try {
  const environment = { ...process.env, HOME: root, OPENCODE_DB: join(root, "core.sqlite"),
    OPENCODE_CONFIG: join(root, "opencode.json"), OPENCODE_CONFIG_DIR: join(root, "config"),
    OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CLI_CONFIG_CONTENT: "{}", TERM: "xterm-256color", COLORTERM: "truecolor",
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
  }
  await Promise.all(["config", "data", "state", "cache", "project"].map((directory) => mkdir(join(root, directory))))
  await Bun.write(environment.OPENCODE_CONFIG, "{}")
  const preview = await prepareDev(repositoryRoot, [...pluginIDs], environment, join(root, "preview"))
  // Create an empty session through the public client so Context's real tab
  // commands are tested, rather than only the host's built-in dialog Escape.
  const probe = join(root, "probe")
  const sessionStarted = join(root, "session-started")
  const sessionReady = join(root, "session-ready")
  await mkdir(probe)
  await Bun.write(join(probe, "index.js"), 'export default { id: "opcode-ui-probe", setup() {} }\n')
  await Bun.write(join(probe, "tui.js"), `export default {
    id: "opcode-ui-probe",
    setup(api) {
      api.keymap.layer(() => ({ mode: "global", commands: [{
        id: "opcode-ui-probe.session", title: "Create isolated keyboard-test session",
        slash: { name: "opcode-test-session" },
        async run() {
          await Bun.write(${JSON.stringify(sessionStarted)}, "started");
          const session = await api.client.session.create({ title: "Opcode keyboard smoke", location: api.location ?? api.data.location.default() });
          api.ui.router.navigate({ type: "session", sessionID: session.id });
          await Bun.write(${JSON.stringify(sessionReady)}, session.id);
        }
      }] }));
    }
  };\n`)
  const cli = JSON.parse(preview.environment.OPENCODE_CLI_CONFIG_CONTENT)
  cli.plugins.push({ package: probe })
  preview.environment.OPENCODE_CLI_CONFIG_CONTENT = JSON.stringify(cli)
  shutdown.signal.throwIfAborted()
  child = Bun.spawn([executable, "--standalone"], { cwd: join(root, "project"), env: preview.environment, terminal })
  await requireText("Ask anything", 0)
  await open("later", "Nothing saved for later")
  if (!await Bun.file(join(preview.data, "later.sqlite")).exists()) throw new Error("Later ignored its CLI-side preview database option")
  if (await Bun.file(join(root, "state/opencode/opencode-later/later.sqlite")).exists()) throw new Error("Later opened its legacy database instead of the preview")
  await key("a", "Add for later")
  await key("\x1b", "Nothing saved for later")
  await key("a", "Add for later")
  terminal.write("Opcode keyboard regression fixture")
  await key("\r", "ACTIVE")
  await key("a", "Add for later")
  terminal.write("Second smoke item")
  await key("\r", "Second smoke item")
  // The new item is outlined: shift+k must move it up rather than act as the vi key k.
  terminal.write("K")
  const order = () => {
    const database = new Database(join(preview.data, "later.sqlite"), { readonly: true })
    try { return database.query<{ message: string }, []>("SELECT message FROM items WHERE completed_at IS NULL ORDER BY position").all().map((row) => row.message) }
    finally { database.close() }
  }
  for (const deadline = Date.now() + 8_000; order()[0] !== "Second smoke item";) {
    if (Date.now() > deadline) throw new Error(`Keyboard smoke: K did not move the item up: ${order().join(", ")}`)
    await Bun.sleep(25)
  }
  await key("\t", "No completed items")
  await key("\x1b", "Ask anything")
  await open("later", "Opcode keyboard regression fixture")
  const pasted = output.length
  await key("\r", "Pasted into the prompt")
  await requireText("Second smoke item", pasted)
  await key("\x03", "Ask anything")
  console.log("Later: real Add/cancel/reorder/History/Escape/paste keys and separate database passed")
  await open("cost", "ALL TOKENS")
  await key("d", "Last 7 days")
  await key("\x1b", "ALL TOKENS")
  await key("\x1b", "Ask anything")
  console.log("Cost: real filter picker/Escape keys passed inside a native dialog")
  await open("sessions-all", "No matching sessions")
  await key("/", "Search sessions")
  terminal.write("\x1b")
  await Bun.sleep(150)
  await key("\x1b", "Ask anything")
  console.log("Sessions: real search/dialog cancellation/Escape keys passed")
  await open("context", "No active session")
  await key("\x1b", "Ask anything")
  console.log("Context: real dialog open/Escape keys passed")
  const creating = output.length
  terminal.write("/opcode-test-session")
  await requireText("Create isolated keyboard-test session", creating)
  terminal.write("\r")
  await Bun.sleep(700)
  if (!await Bun.file(sessionStarted).exists()) terminal.write("\r")
  const sessionDeadline = Date.now() + 8_000
  while (!await Bun.file(sessionReady).exists() && Date.now() < sessionDeadline) {
    shutdown.signal.throwIfAborted()
    await Bun.sleep(25)
  }
  if (!await Bun.file(sessionReady).exists()) throw new Error("Could not create the isolated Context test session")
  await open("context", "RECORDED INPUT")
  await key("\t", "LARGEST RETAINED CONTRIBUTORS")
  await key("\t", "OBSERVABLE ENVIRONMENT")
  await key("\x1b[Z", "LARGEST RETAINED CONTRIBUTORS")
  await key("\x1b", "Opcode keyboard smoke", "Current context")
  console.log("Context: real Tab/Shift+Tab switching passed inside a native dialog")
  await open("sessions-all", "[current] Opcode keyboard smoke")
  await key("\x1b", "Opcode keyboard smoke", "All sessions")
  console.log("Sessions: a real root session loads through the validated search RPC")
} catch (error) {
  if (!shutdown.signal.aborted) throw error
} finally {
  try { await cleanup() } finally {
    process.off("SIGINT", onInterrupt)
    process.off("SIGTERM", onTerminate)
  }
}
