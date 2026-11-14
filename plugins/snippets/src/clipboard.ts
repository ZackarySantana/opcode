import { release } from "node:os"

type Which = (command: string) => string | null
/** Runs a command with optional input, resolving with its output, or undefined when it fails or takes too long. */
type Run = (command: string[], input?: string) => Promise<string | undefined>

// PowerShell's console streams default to the system code page, which mangles anything outside it.
const UTF8 = "[Console]::InputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8"
const powershell = (name: string, script: string) => [name, "-NoProfile", "-NonInteractive", "-Command", `${UTF8}; ${script}`]

/** Clipboard tools for the platform, best first. WSL reads and writes the Windows clipboard, where shared text arrives. */
export function clipboardCommands(platform = process.platform, environment = process.env, kernel = release()): { read: string[][]; write: string[][] } {
  if (platform === "darwin") return { read: [["pbpaste"]], write: [["pbcopy"]] }
  if (platform === "win32") return { read: [powershell("powershell", "Get-Clipboard -Raw")], write: [powershell("powershell", "Set-Clipboard -Value ([Console]::In.ReadToEnd())")] }
  const wsl = Boolean(environment.WSL_DISTRO_NAME) || /microsoft/i.test(kernel)
  const windows = wsl ? { read: [powershell("powershell.exe", "Get-Clipboard -Raw")], write: [powershell("powershell.exe", "Set-Clipboard -Value ([Console]::In.ReadToEnd())")] } : { read: [], write: [] }
  const wayland = environment.WAYLAND_DISPLAY ? { read: [["wl-paste", "--no-newline"]], write: [["wl-copy"]] } : { read: [], write: [] }
  const x11 = environment.DISPLAY
    ? { read: [["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]], write: [["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]] }
    : { read: [], write: [] }
  return { read: [...windows.read, ...wayland.read, ...x11.read], write: [...windows.write, ...wayland.write, ...x11.write] }
}

const run: Run = async (command, input) => {
  try {
    const child = Bun.spawn(command, { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "ignore" })
    if (input !== undefined && child.stdin) { child.stdin.write(input); await child.stdin.end() }
    const timer = setTimeout(() => child.kill(), 5000)
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    clearTimeout(timer)
    return code === 0 ? output : undefined
  } catch { return undefined }
}

export interface Clipboard {
  /** The clipboard's text, or undefined when no tool here could read it. */
  read(): Promise<string | undefined>
  /** Whether a tool here took the text. */
  write(text: string): Promise<boolean>
}

/** The system clipboard through the first available tool. Windows line endings read back as plain newlines. */
export function systemClipboard(which: Which = (command) => Bun.which(command), runner: Run = run, commands = clipboardCommands()): Clipboard {
  const available = (list: string[][]) => list.filter(([name]) => which(name!))
  return {
    async read() {
      for (const command of available(commands.read)) {
        const text = await runner(command)
        if (text !== undefined) return text.replace(/\r\n/g, "\n")
      }
      return undefined
    },
    async write(text) {
      for (const command of available(commands.write)) if (await runner(command, text) !== undefined) return true
      return false
    },
  }
}
