import type { fakeServer } from "@opcode/core/test-support/server"
import type { Remote } from "../src/client"
import type { Runner } from "../src/gh"
import type { PullRequestsState } from "../src/model"
import type { FormattedFeedback } from "../src/rpc"
import { response, teams } from "./fixtures"

/** gh answering the pull request searches from the fixtures, counting them. */
export function ghRunner() {
  const searches: string[] = []
  const run: Runner = async (args) => {
    if (args.includes("graphql")) searches.push(args.join(" "))
    return { stdout: args.includes("graphql") ? response : teams, stderr: "", status: 0 }
  }
  return { run, searches }
}

/** A terminal whose location is `directory`, on a fake server running the plugin. */
export function remote(server: ReturnType<typeof fakeServer>, directory = "/home/me"): Remote {
  return {
    state: (signal) => server.call<PullRequestsState>(directory, "state", {}, signal),
    update: (change) => server.call<PullRequestsState>(directory, "update", { settings: change }),
    refresh: () => server.call<PullRequestsState>(directory, "refresh", {}),
    feedback: (directory, signal) => server.call<FormattedFeedback>(directory, "feedback", {}, signal),
    changes: (signal) => ({
      async *[Symbol.asyncIterator]() {
        for await (const event of server.subscribe(signal)) if (event.name === "changed") yield event.data as PullRequestsState
      },
    }),
  }
}
