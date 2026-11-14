import { expect, test } from "bun:test"
import { opencodeBinary, withOpenCodeHost } from "@opcode/core/test-support/opencode-host"
import { defaultScope, PLUGIN_ID, type PullRequestsState } from "../src/model"
import { GhPrStatusRpc } from "../src/rpc"

if (!opencodeBinary) console.warn("SKIPPED rpc-host.test.ts: no OpenCode binary on PATH or at ~/.opencode/bin/opencode; real RPC validation is untested.")

/** The fake server only round-trips JSON: the real host validates each call and answer against the RPC's schemas. */
test.skipIf(!opencodeBinary)("[requires OpenCode binary] the real host takes scope changes a part at a time, answers with the scope, and refuses malformed ones", async () => {
  await withOpenCodeHost({ entry: new URL("../src/index.ts", import.meta.url), id: PLUGIN_ID }, async ({ client, root }) => {
    const rpc = client.rpc(GhPrStatusRpc)
    // gh isn't signed in on this host, so refreshes fail; the settings don't depend on them.
    const options = () => ({ location: { directory: root }, signal: AbortSignal.timeout(5_000) })
    const scope = async () => ((await rpc.state({}, options())) as PullRequestsState).settings.scope
    expect(await scope()).toEqual(defaultScope)
    await rpc.update({ settings: { scopeMode: "include", scopeOrg: { name: "acme", chosen: true } } }, options())
    const changed = await rpc.update({ settings: { scopeOrg: { name: "Globex", chosen: true } } }, options()) as PullRequestsState
    expect(changed.settings.scope).toEqual({ mode: "include", orgs: ["acme", "Globex"] })
    // The host refuses changes of the wrong shape.
    for (const settings of [{ scopeMode: "sideways" }, { scopeOrg: { name: "acme" } }]) {
      await expect(rpc.update({ settings } as never, options())).rejects.toBeDefined()
    }
    // A name that isn't an org's is left out, and so is a whole scope, which the host passes on without its schema's
    // say: the scope is never replaced whole.
    for (const settings of [{ scopeOrg: { name: "acme/web", chosen: true } }, { scope: defaultScope }]) {
      expect(((await rpc.update({ settings } as never, options())) as PullRequestsState).settings.scope).toEqual(changed.settings.scope)
    }
    expect(await scope()).toEqual(changed.settings.scope)
  })
}, 45_000)
