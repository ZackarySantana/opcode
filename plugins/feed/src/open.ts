import { release } from "node:os"

type Which = (command: string) => string | null

/** Candidate launchers for the platform, best first. xdg-open is the user's choice; WSL falls back to the Windows browser. */
export function launchers(url: string, platform = process.platform, environment = process.env, kernel = release()): string[][] {
  if (platform === "darwin") return [["open", url]]
  if (platform === "win32") return [["rundll32", "url.dll,FileProtocolHandler", url]]
  const wsl = Boolean(environment.WSL_DISTRO_NAME) || /microsoft/i.test(kernel)
  return [
    ...wsl ? [["wslview", url]] : [],
    ["xdg-open", url],
    ...wsl ? [["powershell.exe", "-NoProfile", "-Command", `Start-Process '${url.replaceAll("'", "''")}'`]] : [],
  ]
}

/** Opens an http(s) link in the user's browser. Feed-provided links are never run as other schemes. */
export function openURL(url: string, which: Which = (command) => Bun.which(command)): void {
  const protocol = URL.canParse(url) ? new URL(url).protocol : ""
  if (protocol !== "https:" && protocol !== "http:") throw new Error(`Refusing to open ${url}`)
  const candidates = launchers(url)
  const command = candidates.find(([name]) => which(name!))
  if (!command) throw new Error(`No browser launcher found (tried ${candidates.map(([name]) => name).join(", ")})`)
  Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref()
}
