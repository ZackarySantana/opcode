import type { LocationRef, OpenCodeClient } from "@opencode/client"
import type { Activity, Dashboard, DashboardFilter, ImportStatus, TimeDashboard, Usage } from "./domain.js"
import { CostRpc } from "./rpc.js"

export interface CostService {
  dashboard(filter: DashboardFilter, signal: AbortSignal): Promise<Dashboard>
  time(filter: DashboardFilter, signal: AbortSignal): Promise<TimeDashboard>
  status(signal: AbortSignal): Promise<ImportStatus>
  importBatch(batch: { sessionID: string; records: Usage[] }, signal: AbortSignal): Promise<void>
  importActivity(batch: { sessionID: string; activity: Activity[] }, signal: AbortSignal): Promise<void>
  completeImport(signal: AbortSignal): Promise<void>
}

/** Every call explicitly targets the same connected-server location. No local filesystem access. */
export function createCostService(client: Pick<OpenCodeClient, "rpc">, location: LocationRef): CostService {
  const rpc = client.rpc(CostRpc)
  // Send only filter fields, never extra route state.
  const only = (filter: DashboardFilter) => ({ range: filter.range, projectID: filter.projectID, model: filter.model })
  return {
    dashboard: async (filter, signal) => await rpc.dashboard(only(filter), { location, signal }) as Dashboard,
    time: async (filter, signal) => await rpc.time(only(filter), { location, signal }) as TimeDashboard,
    status: async (signal) => await rpc.status({}, { location, signal }) as ImportStatus,
    importBatch: async (batch, signal) => { await rpc.importBatch(batch, { location, signal }) },
    importActivity: async (batch, signal) => { await rpc.importActivity(batch, { location, signal }) },
    completeImport: async (signal) => { await rpc.completeImport({}, { location, signal }) },
  }
}
