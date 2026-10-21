import type { Context, Route } from "@opencode/plugin/tui/context"
import { CliRenderEvents } from "@opentui/core"

export type PromptRoute = Exclude<Route, { type: "plugin" }>
export type PasteResult = "pasted" | "cancelled" | "unavailable" | "changed"

function sameDestination(current: Route, destination: PromptRoute): boolean {
  return current.type === destination.type &&
    (current.type !== "session" || (destination.type === "session" && current.sessionID === destination.sessionID))
}

function promptReady(api: Pick<Context, "keymap">): boolean {
  return api.keymap.commands().some((command) => command.id === "prompt.paste" &&
    (typeof command.enabled === "function" ? command.enabled() : command.enabled !== false))
}

/** One rendered destination frame is sufficient; global idle can never arrive during animations. */
function waitForPrompt(
  api: Pick<Context, "renderer" | "keymap" | "ui">,
  destination: PromptRoute,
  valid: () => boolean,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<"ready" | "cancelled" | "unavailable"> {
  const renderer = api.renderer
  if (signal.aborted || !valid() || renderer.isDestroyed) return Promise.resolve("cancelled")
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(timer)
      renderer.off(CliRenderEvents.FRAME, frame)
      renderer.off(CliRenderEvents.DESTROY, cancel)
      signal.removeEventListener("abort", cancel)
    }
    const finish = (result: "ready" | "cancelled" | "unavailable") => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const cancel = () => finish("cancelled")
    const destinationValid = () => !signal.aborted && valid() && !renderer.isDestroyed &&
      sameDestination(api.ui.router.current(), destination)
    const frame = () => {
      if (settled) return
      try {
        if (!destinationValid()) cancel()
        else if (promptReady(api)) finish("ready")
      } catch (error) {
        fail(error)
      }
    }
    renderer.on(CliRenderEvents.FRAME, frame)
    renderer.on(CliRenderEvents.DESTROY, cancel)
    signal.addEventListener("abort", cancel, { once: true })
    timer = setTimeout(() => {
      try { finish(destinationValid() ? "unavailable" : "cancelled") } catch (error) { fail(error) }
    }, timeoutMs)
    try {
      api.ui.router.navigate(destination)
      if (!destinationValid()) cancel()
      else if (!settled) renderer.requestRender()
    } catch (error) {
      fail(error)
    }
  })
}

/**
 * V2 exposes no prompt-text setter. Use the public OpenTUI paste pipeline, never
 * prompt submission, clipboard mutation, or host render-tree inspection.
 * Reachable prompt.paste is a readiness check, not a delivery acknowledgement.
 */
export async function pasteIntoPrompt(
  api: Pick<Context, "renderer" | "keymap" | "ui">,
  destination: PromptRoute,
  text: string,
  valid: () => boolean,
  unchanged: () => boolean,
  options: { signal: AbortSignal; timeoutMs?: number },
): Promise<PasteResult> {
  const result = await waitForPrompt(api, destination, valid, options.signal, options.timeoutMs ?? 1000)
  if (result !== "ready") return result
  if (options.signal.aborted || !valid() || api.renderer.isDestroyed || !sameDestination(api.ui.router.current(), destination)) return "cancelled"
  if (!promptReady(api)) return "unavailable"
  if (!unchanged()) return "changed"
  api.renderer.keyInput.processPaste(new TextEncoder().encode(text))
  return "pasted"
}
