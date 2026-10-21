import type { LocationRef, OpenCodeClient } from "@opencode/client"
import type { Dashboard, DashboardFilter, ImportStatus, Usage } from "./domain.js"
import { CostRpc } from "./rpc.js"

export interface CostService {
  dashboard(filter: DashboardFilter, signal: AbortSignal): Promise<Dashboard>
  status(signal: AbortSignal): Promise<ImportStatus>
  importBatch(batch: { sessionID: string; records: Usage[] }, signal: AbortSignal): Promise<void>
  completeImport(signal: AbortSignal): Promise<void>
}

/** Every call explicitly targets the same connected-server location. No local filesystem access. */
export function createCostService(client: Pick<OpenCodeClient, "rpc">, location: LocationRef): CostService {
  const rpc = client.rpc(CostRpc)
  return {
    dashboard: async (filter, signal) => await rpc.dashboard({
      range: filter.range, projectID: filter.projectID, model: filter.model,
    }, { location, signal }) as Dashboard,
    status: async (signal) => await rpc.status({}, { location, signal }) as ImportStatus,
    importBatch: async (batch, signal) => { await rpc.importBatch(batch, { location, signal }) },
    completeImport: async (signal) => { await rpc.completeImport({}, { location, signal }) },
  }
}
