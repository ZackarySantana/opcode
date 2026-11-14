import { expect, test } from "bun:test"
import { clipboardCommands, systemClipboard } from "../src/clipboard"

test("WSL uses the Windows clipboard first, and Linux desktops their own tools", () => {
  const names = (commands: string[][]) => commands.map(([name]) => name)
  const wsl = clipboardCommands("linux", { WSL_DISTRO_NAME: "Ubuntu", WAYLAND_DISPLAY: "wayland-0" }, "6.6-microsoft-standard-WSL2")
  expect(names(wsl.read)).toEqual(["powershell.exe", "wl-paste"])
  expect(names(clipboardCommands("linux", { DISPLAY: ":0" }, "6.8").write)).toEqual(["xclip", "xsel"])
  expect(clipboardCommands("darwin", {}, "")).toEqual({ read: [["pbpaste"]], write: [["pbcopy"]] })
  expect(clipboardCommands("linux", {}, "6.8")).toEqual({ read: [], write: [] })
})

test("the clipboard tries each installed tool in turn and reads Windows line endings as newlines", async () => {
  const ran: string[] = []
  const clipboard = systemClipboard((name) => name === "missing" ? null : name, async ([name], input) => {
    ran.push(input === undefined ? name! : `${name}<${input}`)
    return name === "broken" ? undefined : "one\r\ntwo"
  }, { read: [["missing"], ["broken"], ["works"]], write: [["broken"], ["works"]] })
  expect(await clipboard.read()).toBe("one\ntwo")
  expect(await clipboard.write("text")).toBe(true)
  expect(ran).toEqual(["broken", "works", "broken<text", "works<text"])
  expect(await systemClipboard(() => null, async () => "x", { read: [["a"]], write: [["a"]] }).read()).toBeUndefined()
})
