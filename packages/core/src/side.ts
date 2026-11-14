/**
 * Sessions an opcode plugin starts beside the one you're in, to do work for it, such as Review's questions about a
 * diff. They are not subagents (a child session would report to its parent and wake it), so the link lives in the
 * session's metadata, where any plugin can read it.
 */

/** The metadata key that marks a side session. */
export const SIDE_SESSION = "opcode.side"

export interface SideSession {
  /** The session the work is for. */
  readonly parentID: string
  /** The plugin that started it. */
  readonly plugin: string
}

/** Metadata for `session.create` that marks the session as a side session of `parentID`. */
export const sideSessionMetadata = (side: SideSession) => ({ [SIDE_SESSION]: { parentID: side.parentID, plugin: side.plugin } })

/** The side session a session's metadata marks, if any. */
export function sideSessionOf(session: { readonly metadata?: { readonly [key: string]: unknown } }): SideSession | undefined {
  const value = session.metadata?.[SIDE_SESSION]
  if (!value || typeof value !== "object") return undefined
  const { parentID, plugin } = value as Record<string, unknown>
  return typeof parentID === "string" && typeof plugin === "string" ? { parentID, plugin } : undefined
}
