import { selectOptions, type Copy, type Option, type Shown } from "./view"

/** Lists every pull request to pick one, or says why there is nothing to pick. */
export function pickable(shown: Shown, copy: Copy): { options: Option[] } | { title: string; description?: string; error: boolean } {
  const { error } = shown
  if (!shown.snapshot) return error ? { title: copy.t("error.title"), description: error, error: true } : { title: copy.t("select.loading"), error: false }
  const options = selectOptions(shown, copy)
  return options.length ? { options } : { title: copy.t("select.empty"), description: error, error: !!error }
}
