import type { Route } from "@opencode/plugin/tui/context"
import { ownsScreen } from "@opcode/ui/screen"
import { DATE_RANGES, type DashboardFilter, type DateRange } from "./domain.js"

export const PLUGIN_ID = "opcode-cost"
export const ROUTE = "opcode-cost.dashboard"
export const MODE = ROUTE
export const TABS = ["cost", "time"] as const
export type Tab = (typeof TABS)[number]
export type RouteState = DashboardFilter & { tab: Tab }

export function isDashboardRoute(route: Route) {
  return ownsScreen(route, { id: PLUGIN_ID, name: ROUTE })
}

export function parseRoute(params?: Record<string, unknown>): RouteState {
  const range = DATE_RANGES.includes(params?.range as DateRange) ? params!.range as DateRange : "30d"
  return {
    range,
    projectID: typeof params?.projectID === "string" ? params.projectID : undefined,
    model: typeof params?.model === "string" ? params.model : undefined,
    tab: params?.tab === "time" ? "time" : "cost",
  }
}

/** Daily activity is always available, including narrow screens with both entity filters. */
export function dashboardSections(filter: DashboardFilter) {
  return { projects: !filter.projectID, models: !filter.model, daily: true }
}
