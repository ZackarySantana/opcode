import type { Context } from "@opencode/plugin/tui/context"
import { describeError, type Remote } from "./client"

/** Sends the review feedback on the open session's pull request to that session, as your prompt. */
export async function sendFeedback(api: Pick<Context, "client" | "ui">, remote: Pick<Remote, "feedback">, signal: AbortSignal): Promise<void> {
  const route = api.ui.router.current()
  if (route.type !== "session") return api.ui.toast.show({ variant: "warning", message: "Open a session first: /ghpr-comments sends to the open session." })
  const { sessionID } = route
  api.ui.toast.show({ message: "Fetching review comments..." })
  try {
    // The session's directory, not the terminal's, picks the branch; the server reads it there.
    const session = await api.client.session.get({ sessionID }, { signal })
    const { number, text, summary } = await remote.feedback(session.location.directory, signal)
    const title = `PR #${number}`
    if (!text) return api.ui.toast.show({ title, message: `No review comments to send. ${summary}` })
    await api.client.session.prompt({ sessionID, text }, { signal })
    api.ui.toast.show({ variant: "success", title, message: `Sent review comments. ${summary}` })
  } catch (error) {
    if (!signal.aborted) api.ui.toast.show({ variant: "error", title: "Review comments", message: describeError(error) })
  }
}
