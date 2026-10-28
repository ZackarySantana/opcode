import { errorMessage } from "./index"

/** A closed JSON Schema object, for RPC contracts and tool inputs. */
export const object = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object" as const, properties, required, additionalProperties: false as const })

export const empty = object({}, [])

/**
 * The declared error most methods need. Undeclared handler errors reach clients only as a generic rpc.internal
 * failure, so handlers report through `guarded`.
 */
export const failed = { failed: empty }

/** The part of an RPC handler's context `guarded` uses. */
export interface RpcCall<Type extends string> {
  readonly signal: AbortSignal
  error(type: Type, message: string, data: Record<string, never>): unknown
}

/**
 * Runs a handler's work, reporting its failure as a declared error with the failure's message: `failed`, or what
 * `classify` picks. A call the client aborted rethrows the original error rather than reporting a failure.
 */
export async function guarded<T, Type extends string = "failed">(call: RpcCall<Type>, action: () => Promise<T> | T, classify?: (error: unknown) => Type): Promise<T> {
  try { return await action() } catch (error) {
    if (call.signal.aborted) throw error
    throw call.error(classify ? classify(error) : "failed" as Type, errorMessage(error), {})
  }
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** What RPC validation and plugin storage accept: JSON, which has no undefined, where domain objects leave fields unset. */
export const toJson = (value: object) => JSON.parse(JSON.stringify(value)) as { [key: string]: Json }

/** Why an RPC call failed, saying what to do when the server doesn't run the plugin's server side, or another version. */
export function describeRpcError(error: unknown, plugin: { name: string; package: string }): string {
  const type = error && typeof error === "object" && "type" in error ? error.type : undefined
  if (type === "rpc.unavailable") return `The OpenCode server isn't running ${plugin.name}: add ${plugin.package} to the server's plugins.`
  if (type === "rpc.method_not_found") return `The OpenCode server runs another version of ${plugin.name}: update ${plugin.package} there.`
  return errorMessage(error)
}
