import type { ConfigEntry, LocationRef, SessionMessageInfo } from "@opencode/client"

export const user = (id: string, text = "hello"): SessionMessageInfo => ({ id, type: "user", time: { created: 1 }, text })

export function mockHost() {
  const location = { directory: "/session" }
  const locations: LocationRef[] = []
  const catalogReads: { catalog: string; operation: "sync" | "list"; location: LocationRef }[] = []
  const sessionReads: { method: "get" | "context"; sessionID: string }[] = []
  const history = [user("user-1")]
  const collection = <T>(catalog: string, items: T[] = []) => ({
    sync: async (value: LocationRef) => { locations.push(value); catalogReads.push({ catalog, operation: "sync", location: value }) },
    list: (value: LocationRef) => { catalogReads.push({ catalog, operation: "list", location: value }); return items },
  })
  const host = {
    location: { directory: "/plugin" },
    client: {
      session: {
        get: async ({ sessionID }: { sessionID: string }, _options?: { signal?: AbortSignal }) => {
          sessionReads.push({ method: "get", sessionID }); return { location, model: undefined }
        },
        context: async ({ sessionID }: { sessionID: string }, _options?: { signal?: AbortSignal }): Promise<SessionMessageInfo[]> => {
          sessionReads.push({ method: "context", sessionID }); return history
        },
      },
      message: { list: async (_input: { sessionID: string; cursor?: string; order?: "asc" | "desc"; limit?: number }, _options?: { signal?: AbortSignal }) => ({ data: history, cursor: {} as { next?: string } }) },
      config: { get: async ({ location }: { location: LocationRef }): Promise<ConfigEntry[]> => {
        locations.push(location)
        return [{ type: "document", info: { instructions: ["AGENTS.md"], skills: ["./skills"] } }]
      } },
      rpc: () => ({ tools: async (_input: object, { location }: { location: LocationRef }): Promise<{ id: string; description?: string }[]> => {
        locations.push(location)
        return [{ id: "read", description: "Read a file" }]
      } }),
    },
    data: {
      session: {
        get: (_id: string) => ({ location, model: undefined }),
        message: { list: (_id: string): SessionMessageInfo[] | undefined => history },
      },
      location: {
        default: () => ({ directory: "/default" }),
        provider: collection("provider"), model: collection("model"),
        agent: collection("agent", [{ id: "build", description: "Build" }]),
        skill: collection("skill", [{ id: "testing", description: "Testing" }]),
        mcp: { server: collection("mcp", [{ name: "docs", status: { status: "connected" } }]) },
      },
    },
  }
  return { host, history, location, locations, catalogReads, sessionReads }
}
