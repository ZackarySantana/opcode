import { expect, test } from "bun:test"
import { age, refreshStatus } from "../src/format"
import { launchers, openURL } from "../src/open"

test("links open with the platform's launcher, and only http(s) links open at all", () => {
  expect(launchers("https://a.test", "darwin")).toEqual([["open", "https://a.test"]])
  expect(launchers("https://a.test", "linux", {}, "6.8.0-generic")).toEqual([["xdg-open", "https://a.test"]])
  const wsl = launchers("https://a.test/?q='x'", "linux", { WSL_DISTRO_NAME: "Ubuntu" }, "6.18-microsoft-standard-WSL2")
  expect(wsl.map(([name]) => name)).toEqual(["wslview", "xdg-open", "powershell.exe"])
  expect(wsl[2]!.at(-1)).toBe("Start-Process 'https://a.test/?q=''x'''")
  expect(() => openURL("file:///etc/passwd", () => "/bin/true")).toThrow("Refusing to open")
  expect(() => openURL("https://a.test", () => null)).toThrow("No browser launcher found")
})

test("ages are compact", () => {
  const now = Date.parse("2026-10-21T12:00:00Z")
  const hours = (count: number) => now - count * 60 * 60_000
  expect(age(now - 5 * 60_000, now)).toBe("5m")
  expect(age(hours(23.9), now)).toBe("23h")
  expect(age(hours(29), now)).toBe("1d 5h")
  expect(age(hours(48), now)).toBe("2d")
  expect(age(hours(9 * 24 + 3), now)).toBe("9d 3h")
  // Upcoming items count the other way, with the same format.
  expect(age(now, hours(-30))).toBe("1d 6h")
  expect(age(undefined, now)).toBe("")
})

test("the refresh countdown counts down to the second", () => {
  const now = Date.parse("2026-10-21T12:00:00Z")
  expect(refreshStatus(true, now + 5 * 60_000, now)).toBe("refreshing…")
  expect(refreshStatus(false, now + 4 * 60_000 + 5_500, now)).toBe("4m 06s")
  expect(refreshStatus(false, now + 60 * 60_000, now)).toBe("60m 00s")
  expect(refreshStatus(false, now + 30_000, now)).toBe("30s")
  expect(refreshStatus(false, now - 1_000, now)).toBe("0s")
  expect(refreshStatus(false, undefined, now)).toBeUndefined()
})
