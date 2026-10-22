# Verification

## Try the UI

From the checkout, run `mise run dev` (or `mise run dev later` for one plugin).
The launcher installs dependencies, builds, configures local entrypoints, and
starts OpenCode. While it runs, published copies of the previewed plugins are
taken out of your global config and restored on exit (see
[development](development.md)). It stores separate preview plugin databases under
`.release/dev/data`, retaining them across runs.

This uses your normal OpenCode login/session database and other server settings;
it is **not isolated**. Your global CLI-only plugin list is temporarily replaced
with the server-provided extensions; themes/keybinds remain inherited. Submitted
prompts behave normally and may incur model costs. Use the isolated server smoke
check below when you do not want to use normal session data.

For actual keyboard dispatch—not mocked command callbacks—run:

```sh
mise run smoke-ui
```

This builds the plugins and drives an isolated OpenCode TUI through a real Bun
pseudo-terminal and a headless terminal emulator. It checks Later
add/cancel/history/Escape/paste, Cost filters, Sessions search and a populated
root-session result, and Context tab switching/dismissal. An empty test session
is created through the public API. Core and plugin databases are temporary;
no prompts are submitted and no model calls are requested.

## Automated gate

```sh
mise exec -- bun install --frozen-lockfile
mise run check
```

The gate covers typechecking, domain/adapter regression tests, and distributable
builds. Packaging checks must verify resolved catalogs, bundled private code,
valid exports, and external host runtimes.

With OpenCode V2 installed, the optional isolated server smoke check is:

```sh
mise exec -- bun test/host-smoke.ts .release/opcode-context .release/opcode-cost .release/opcode-later .release/opcode-sessions
```

This starts a private server with temporary HOME/XDG directories, activates each
built server export, and checks its status without making model requests or
touching your normal service/databases. Local root-entrypoint bridges exercise
the built exports; tarball tests separately validate npm package structure.
Server activation does not establish interactive TUI behavior.
Run it only against trusted local artifacts: isolated state is not a security
sandbox for arbitrary plugin code.

## Interactive release smoke test

Use a disposable project and copies of existing databases. Do not point a test at
your only copy of a production ledger or session index.

- Load each built package individually, then all of them together. Confirm plugin
  IDs and command palette entries without duplicate commands from the originals.
- Context: open from home and a session; inspect each tab; navigate past one
  screen; resize; refresh during streaming; export and inspect permissions and
  absence of conversation bodies. Disconnect an API request and check that the
  fallback is visibly qualified.
- Cost: import pre-compaction history, change date/project/model filters, inspect
  a narrow terminal with both entity filters set, refresh/reconnect, and restart
  against the same ledger. Repeated import must not double totals.
- Later: add multiline Unicode items, reorder, edit, complete, restore, delete;
  make a second client modify the selected item. Paste an item into both home and
  session prompts: it must not submit. Cancel dialogs and unload mid-action.
- Sessions: search title/path/message text, try invalid regex, toggle children,
  navigate beyond a screen, inspect a preview, and refresh after deletion. Verify
  cross-directory resume requires confirmation and quotes paths safely.
- Reload/disable each plugin while its view and a request are active. Check
  route restoration, no stray timers/listeners, and no closed-database errors.
- Repeat Cost and Sessions with a remote server. They must use that server's
  ledger/index. Later and explicit Context exports remain client-local.
- Check light/dark themes, live theme changes, keyboard focus, a short terminal,
  and long labels without relying on host renderable internals.

Automated checks and review findings are not evidence that this interactive
matrix has been performed. Record the host version and results when releasing.
