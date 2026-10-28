import type { Composer, Toasts } from "@opencode/plugin/gui"
import type { FormattedFeedback } from "../rpc"
import { selectOptions, type Copy, type Option, type Shown } from "./view"

/**
 * Puts the review feedback on the session's pull request into its prompt, for the user to review and send. The
 * session's directory picks the branch.
 */
export async function addReviewComments(input: {
  session: { readonly directory: string } | undefined
  composer: Pick<Composer, "insert" | "focus"> | undefined
  feedback(directory: string): Promise<FormattedFeedback>
  toast: Pick<Toasts, "show">
  copy: Copy
  describe(error: unknown): string
}): Promise<void> {
  const { session, composer, toast, copy } = input
  if (!session || !composer) {
    toast.show({ title: copy.t("comments.session") })
    return
  }
  const fetching = toast.show({ variant: "loading", title: copy.t("comments.fetching"), persistent: true })
  try {
    const { number, text, summary } = await input.feedback(session.directory)
    if (!text) {
      toast.show({ title: copy.t("comments.empty", { number }), description: summary })
      return
    }
    composer.insert(text)
    composer.focus()
    toast.show({ variant: "success", title: copy.t("comments.added", { number }), description: summary })
  } catch (error) {
    toast.show({ variant: "error", title: copy.t("comments.failed"), description: input.describe(error) })
  } finally {
    fetching.dismiss()
  }
}

/** Lists every pull request to pick one, or says why there is nothing to pick. */
export function pickable(shown: Shown, copy: Copy): { options: Option[] } | { title: string; description?: string; error: boolean } {
  const { error } = shown
  if (!shown.snapshot) return error ? { title: copy.t("error.title"), description: error, error: true } : { title: copy.t("select.loading"), error: false }
  const options = selectOptions(shown, copy)
  return options.length ? { options } : { title: copy.t("select.empty"), description: error, error: !!error }
}
