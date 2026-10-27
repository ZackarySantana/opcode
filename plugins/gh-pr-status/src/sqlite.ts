import type { Database } from "bun:sqlite"
import { join } from "node:path"
import { openDatabase, resolveStatePath, stateDirectory } from "@opcode/core/state"
import { defaultSettings, orderChoices, refreshChoices, sidebarItemChoices, type Order, type Settings } from "./model"

export function databasePath(option?: unknown, state = stateDirectory()): string {
  return resolveStatePath(option, join("opcode-gh-pr-status", "gh-pr-status.sqlite"), state)
}

type Row = { order: string; sidebarMine: number; sidebarTeams: number; sidebarItems: number; refreshMinutes: number; team: string | null }

/** Client-local settings, including the Teams tab's filter. Pull requests are not persisted. */
export class SettingsDatabase {
  private readonly db: Database
  private closed = false

  constructor(path: string) {
    this.db = openDatabase(path, (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sort_order TEXT NOT NULL,
        sidebar_mine INTEGER NOT NULL,
        sidebar_teams INTEGER NOT NULL,
        sidebar_items INTEGER NOT NULL,
        refresh_minutes INTEGER NOT NULL,
        team TEXT
      )
    `))
  }

  settings(): Settings {
    const row = this.db.query<Row, []>(`SELECT sort_order AS "order", sidebar_mine AS sidebarMine, sidebar_teams AS sidebarTeams,
      sidebar_items AS sidebarItems, refresh_minutes AS refreshMinutes, team FROM settings WHERE id = 1`).get()
    if (!row) return defaultSettings
    return {
      order: orderChoices.includes(row.order as Order) ? row.order as Order : defaultSettings.order,
      sidebarMine: row.sidebarMine === 1,
      sidebarTeams: row.sidebarTeams === 1,
      sidebarItems: sidebarItemChoices.includes(row.sidebarItems) ? row.sidebarItems : defaultSettings.sidebarItems,
      refreshMinutes: refreshChoices.includes(row.refreshMinutes) ? row.refreshMinutes : defaultSettings.refreshMinutes,
      team: row.team ?? undefined,
    }
  }

  save(settings: Settings): void {
    this.db.query(`INSERT INTO settings (id, sort_order, sidebar_mine, sidebar_teams, sidebar_items, refresh_minutes, team) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET sort_order = excluded.sort_order, sidebar_mine = excluded.sidebar_mine, sidebar_teams = excluded.sidebar_teams,
        sidebar_items = excluded.sidebar_items, refresh_minutes = excluded.refresh_minutes, team = excluded.team`)
      .run(settings.order, settings.sidebarMine, settings.sidebarTeams, settings.sidebarItems, settings.refreshMinutes, settings.team ?? null)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
