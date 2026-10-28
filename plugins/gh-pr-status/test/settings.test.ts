import { expect, test } from "bun:test"
import { defaultSettings, type Settings } from "../src/model"
import { SettingsDatabase } from "../src/sqlite"

test("settings start at the defaults and keep every change", () => {
  const database = new SettingsDatabase(":memory:")
  try {
    expect(database.settings()).toEqual(defaultSettings)
    const changed: Settings = { order: "oldest", ignoreDays: 0, sidebarMine: false, sidebarTeams: false, sidebarItems: 10, refreshMinutes: 15, team: "acme/web" }
    database.save(changed)
    expect(database.settings()).toEqual(changed)
  } finally {
    database.close()
  }
})
